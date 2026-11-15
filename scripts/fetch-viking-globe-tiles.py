from __future__ import annotations

import io
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "veri" / "karolar" / "kure_viking_renkli"
ALBEDO_REF = ROOT / "public" / "veri" / "karolar" / "kure_albedo" / "2" / "2" / "1.png"
BASE_URL = "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/viking_mdim21_global"


def fetch_tile(z: int, x: int, y_xyz: int) -> tuple[bool, str]:
    out_path = OUT_DIR / str(z) / str(x) / f"{y_xyz}.webp"
    if out_path.exists() and out_path.stat().st_size > 0:
        return True, f"skip {z}/{x}/{y_xyz}"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    y_tms = (1 << z) - 1 - y_xyz
    url = f"{BASE_URL}/{z}/{x}/{y_tms}.png"

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "MarswalkMapTileFetcher/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
            img = Image.open(io.BytesIO(data)).convert("RGB")
            tmp_path = out_path.with_suffix(".webp.tmp")
            img.save(tmp_path, format="WEBP", quality=85, method=4)
            tmp_path.replace(out_path)
            return True, f"ok {z}/{x}/{y_xyz}"
        except Exception as err:  # noqa: BLE001
            last_err = err
            time.sleep(0.35 * (attempt + 1))

    return False, f"FAIL {z}/{x}/{y_xyz} ({url}): {last_err}"


def pearson_corr(path_a: Path, path_b: Path) -> float:
    a = Image.open(path_a).convert("L")
    b = Image.open(path_b).convert("L")
    if a.size != b.size:
        b = b.resize(a.size, Image.Resampling.BILINEAR)
    get_a = getattr(a, "get_flattened_data", a.getdata)
    get_b = getattr(b, "get_flattened_data", b.getdata)
    pa = list(get_a())
    pb = list(get_b())
    n = len(pa)
    ma = sum(pa) / n
    mb = sum(pb) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(pa, pb))
    den = math.sqrt(sum((x - ma) ** 2 for x in pa) * sum((y - mb) ** 2 for y in pb))
    return num / den if den > 0 else 0.0


def main() -> None:
    tasks = []
    for z in range(6):
        dim = 1 << z
        for x in range(dim):
            for y_xyz in range(dim):
                tasks.append((z, x, y_xyz))

    failures: list[str] = []
    done = 0
    total = len(tasks)
    print(f"Fetching {total} USGS Viking MDIM 2.1 tiles (z0-z5) -> {OUT_DIR}")

    with ThreadPoolExecutor(max_workers=24) as pool:
        futs = [pool.submit(fetch_tile, z, x, y) for (z, x, y) in tasks]
        for fut in as_completed(futs):
            ok, msg = fut.result()
            done += 1
            if not ok:
                failures.append(msg)
            if done % 250 == 0 or done == total:
                print(f"  progress: {done}/{total} (failures={len(failures)})")

    if failures:
        for f in failures[:10]:
            print("ERROR:", f)
        raise SystemExit(f"Tile download failed for {len(failures)} tiles")

    written = list(OUT_DIR.rglob("*.webp"))
    assert len(written) == 1365, f"Expected 1365 tiles, found {len(written)}"
    total_mb = sum(p.stat().st_size for p in written) / (1024 * 1024)

    corr = pearson_corr(OUT_DIR / "2" / "2" / "1.webp", ALBEDO_REF)
    print(f"Done: {len(written)} tiles ({total_mb:.2f} MB), correlation with kure_albedo/2/2/1.png = {corr:.4f}")
    assert corr > 0.50, f"Alignment check failed: correlation {corr:.4f} <= 0.50"


if __name__ == "__main__":
    main()
