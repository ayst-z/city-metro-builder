import argparse
import heapq
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

VERSION = "1.0.0"


def points(value, name):
    out = np.asarray(value, dtype=float)
    if out.ndim != 2 or out.shape[1] != 2 or not np.isfinite(out).all():
        raise ValueError(name + " must contain finite [x,y] pairs")
    return out


def fit_transform(anchors, checks, crs, tolerance_m=250):
    if crs not in ("gcj02", "wgs84"):
        raise ValueError("explicit anchor CRS required")
    if len(anchors) < 3 or len(checks) < 2:
        raise ValueError("need >=3 fit anchors and >=2 independent check anchors")
    names = [a["name"] for a in anchors + checks]
    if len(names) != len(set(names)):
        raise ValueError("fit and check anchors must be distinct stations")
    p = points([a["pixel"] for a in anchors], "anchors.pixel")
    geo = points([a["coord"] for a in anchors], "anchors.coord")
    origin, center = geo.mean(axis=0), p.mean(axis=0)
    meter = np.array([111320 * math.cos(math.radians(origin[1])), 110540])
    scale = np.std(p, axis=0)
    if min(scale) < 1e-6:
        raise ValueError("degenerate anchor distribution")
    design = np.column_stack(((p - center) / scale, np.ones(len(p))))
    coeff, _, rank, singular = np.linalg.lstsq(design, (geo - origin) * meter, rcond=None)
    condition = float(singular[0] / max(singular[-1], 1e-15))
    if rank < 3 or condition > 1000:
        raise ValueError("collinear or ill-conditioned anchors")
    result = {"crs": crs, "origin": origin.tolist(), "center": center.tolist(),
              "scale": scale.tolist(), "meter": meter.tolist(), "coeff": coeff.tolist(),
              "condition": condition, "toleranceM": tolerance_m}
    for label, rows in (("fit", anchors), ("check", checks)):
        pred = project(result, [a["pixel"] for a in rows])
        error = np.linalg.norm((pred - np.asarray([a["coord"] for a in rows])) * meter, axis=1)
        result[label] = [{"name": a["name"], "errorM": round(float(e), 2)} for a, e in zip(rows, error)]
    result["maxErrorM"] = max(a["errorM"] for a in result["fit"] + result["check"])
    result["ok"] = result["maxErrorM"] <= tolerance_m
    result["hull"] = cv2.convexHull(p.astype(np.float32)).reshape(-1, 2).tolist()
    return result


def project(fit, pixel):
    p = points(pixel, "pixel")
    design = np.column_stack(((p - fit["center"]) / fit["scale"], np.ones(len(p))))
    return design @ np.asarray(fit["coeff"]) / fit["meter"] + fit["origin"]


def trace_segment(image, start, end, color, via=None, lab_tolerance=32, bridge_px=8,
                  margin_px=30, max_states=600000):
    controls = points([start] + (via or []) + [end], "route controls")
    h, w = image.shape[:2]
    if ((controls < 0).any() or (controls[:, 0] >= w).any() or (controls[:, 1] >= h).any()):
        raise ValueError("route control outside image")
    lo = np.maximum(np.floor(controls.min(axis=0) - margin_px).astype(int), 0)
    hi = np.minimum(np.ceil(controls.max(axis=0) + margin_px + 1).astype(int), [w, h])
    roi = image[lo[1]:hi[1], lo[0]:hi[0]]
    if roi.shape[0] * roi.shape[1] > 4000000:
        raise ValueError("segment ROI too large; split at verified stations or use a smaller work image")
    rgb = np.array([int(color[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.uint8)
    target = cv2.cvtColor(rgb.reshape(1, 1, 3), cv2.COLOR_RGB2LAB).astype(float)[0, 0]
    lab = cv2.cvtColor(roi, cv2.COLOR_RGB2LAB).astype(float)
    delta = np.linalg.norm(lab - target, axis=2)
    mask = (delta <= lab_tolerance).astype(np.uint8)
    if not mask.any():
        raise ValueError("line color absent in segment ROI")
    outside = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 5)
    inside = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    cost = 1 + outside * 5 + 4 / (1 + inside)
    permitted = outside <= bridge_px
    rh, rw = mask.shape
    path = []
    visited = 0
    for a, b in zip(controls[:-1], controls[1:]):
        sx, sy = np.rint(a - lo).astype(int)
        tx, ty = np.rint(b - lo).astype(int)
        if not permitted[sy, sx] or not permitted[ty, tx]:
            raise ValueError("station/waypoint not near target color; inspect pixel or color")
        queue = [(math.hypot(tx - sx, ty - sy), 0.0, int(sx), int(sy))]
        scores = {(int(sx), int(sy)): 0.0}
        previous = {}
        found = False
        while queue:
            _, g, x, y = heapq.heappop(queue)
            if g > scores.get((x, y), math.inf):
                continue
            visited += 1
            if visited > max_states:
                raise ValueError("trace budget exceeded; tighten ROI or add observed waypoints")
            if (x, y) == (tx, ty):
                found = True
                break
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < rw and 0 <= ny < rh and permitted[ny, nx]):
                    continue
                ng = g + math.hypot(dx, dy) * float(cost[ny, nx])
                if ng < scores.get((nx, ny), math.inf):
                    scores[(nx, ny)] = ng
                    previous[(nx, ny)] = (x, y)
                    heapq.heappush(queue, (ng + math.hypot(tx - nx, ty - ny), ng, nx, ny))
        if not found:
            raise ValueError("color path disconnected; no straight-line fallback")
        chain = [(int(tx), int(ty))]
        while chain[-1] != (sx, sy):
            chain.append(previous[chain[-1]])
        chain.reverse()
        path.extend(chain if not path else chain[1:])
    run = longest = 0
    hits = 0
    for x, y in path:
        hits += int(mask[y, x])
        run = 0 if mask[y, x] else run + 1
        longest = max(longest, run)
    coverage = hits / len(path)
    if coverage < 0.65 or longest > 2 * bridge_px + 3:
        raise ValueError("insufficient color evidence or unverified long gap")
    dense = (np.asarray(path) + lo).astype(float)
    dense[0], dense[-1] = controls[0], controls[-1]
    return dense.tolist(), {"colorCoverage": round(coverage, 4), "maxGapPx": longest,
                            "visited": visited, "points": len(path)}


def chaikin(pts, iterations=3):
    """Chaikin 切角平滑：消除栅格阶梯又保留整体走向，端点不动。"""
    cur = [tuple(p) for p in pts]
    for _ in range(iterations):
        if len(cur) < 3:
            break
        nxt = [cur[0]]
        for i in range(len(cur) - 1):
            a, b = cur[i], cur[i + 1]
            nxt.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            nxt.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        nxt.append(cur[-1])
        cur = nxt
    return [list(p) for p in cur]


def compile_plan(image, manifest):
    if manifest.get("source", {}).get("workSize") != [image.shape[1], image.shape[0]]:
        raise ValueError("work image dimensions do not match pixel manifest")
    fit = fit_transform(manifest["anchors"], manifest["checks"], manifest["crs"],
                        manifest.get("toleranceM", 250))
    if not fit["ok"]:
        return {"ok": False, "stage": "registration", "fit": fit, "lines": []}
    result = {"version": VERSION, "ok": True, "crs": manifest["crs"],
              "source": manifest["source"], "fit": fit, "lines": [], "blocked": []}
    hull = np.asarray(fit["hull"], dtype=np.float32)
    names = [line["name"] for line in manifest["lines"]]
    if len(set(names)) != len(names):
        raise ValueError("duplicate line names")
    for line in manifest["lines"]:
        try:
            stations = line["stations"]
            if len(stations) < 2 or any(not s.get("name") for s in stations):
                raise ValueError("at least two named stations required")
            if len(line["segments"]) != len(stations) - 1:
                raise ValueError("segment count must match station order")
            coords = project(fit, [s["pixel"] for s in stations])
            extrapolated = [s["name"] for s in stations if cv2.pointPolygonTest(hull, tuple(map(float, s["pixel"])), False) < 0]
            if extrapolated:
                raise ValueError("outside verified anchor coverage: " + ", ".join(extrapolated))
            paths, metrics, pixel_paths, corner_paths = [], [], [], []
            for i, seg in enumerate(line["segments"]):
                px, quality = trace_segment(image, stations[i]["pixel"], stations[i + 1]["pixel"],
                                            seg.get("color", line["color"]), via=seg.get("via"),
                                            **manifest.get("trace", {}))
                if any(cv2.pointPolygonTest(hull, tuple(p), False) < 0 for p in px):
                    raise ValueError("path leaves verified anchor coverage")
                pixel_paths.append(px)
                corner_paths.append(project(fit, chaikin(px, 3)).tolist())
                paths.append(project(fit, px).tolist())
                metrics.append(quality)
            result["lines"].append({"name": line["name"], "color": line["color"],
                                    "spec": line.get("spec"), "specSource": line.get("specSource"),
                                    "stations": [dict(name=s["name"], lng=c[0], lat=c[1], pixel=s["pixel"],
                                                      via="plan-image") for s, c in zip(stations, coords)],
                                    "paths": paths, "pixelPaths": pixel_paths,
                                    "cornerPaths": corner_paths, "quality": metrics})
        except (ValueError, KeyError) as e:
            result["blocked"].append({"line": line.get("name"), "reason": str(e)})
    result["ok"] = not result["blocked"]
    return result


def prepare_image(source, output, max_side):
    if not 256 <= max_side <= 10000:
        raise ValueError("max-side must be 256..10000")
    Image.MAX_IMAGE_PIXELS = 400000000
    with Image.open(source) as image:
        original = image.size
        if image.format == "JPEG":
            image.draft("RGB", (max_side, max_side))
        elif original[0] * original[1] > 40000000:
            raise ValueError("large non-JPEG requires external tiled decoder")
        image.thumbnail((max_side, max_side))
        image.convert("RGB").save(output, quality=95)
        return {"originalSize": original, "workSize": image.size,
                "pixelToOriginal": {"offset": [0, 0], "scale": [original[0] / image.width, original[1] / image.height]}}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("image")
    prep.add_argument("output")
    prep.add_argument("--max-side", type=int, default=6000)
    run = sub.add_parser("compile")
    run.add_argument("image")
    run.add_argument("manifest")
    run.add_argument("output")
    args = parser.parse_args()
    if not Path(args.output).parent.is_dir():
        raise ValueError("output parent does not exist")
    if args.command == "prepare":
        report = prepare_image(args.image, args.output, args.max_side)
    else:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        with Image.open(args.image) as src:
            if src.width * src.height > 40000000:
                raise ValueError("use prepare or crops before compile")
            image = np.asarray(src.convert("RGB"))
        report = compile_plan(image, manifest)
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        report = {"ok": report["ok"], "lines": len(report["lines"]), "blocked": report.get("blocked", []),
                  "maxErrorM": report["fit"]["maxErrorM"], "output": args.output}
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report.get("ok", True) else 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(2)
