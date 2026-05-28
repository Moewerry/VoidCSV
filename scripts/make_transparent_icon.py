from pathlib import Path

import numpy as np
from PIL import Image


def main() -> None:
    src = Path(r"e:\03_Development\Projects\experiments\VoidCSV\web\public\voidcsv-icon.png")
    out_png = Path(r"e:\03_Development\Projects\experiments\VoidCSV\web\public\voidcsv-icon-transparent.png")
    out_ico = Path(r"e:\03_Development\Projects\experiments\VoidCSV\web\public\voidcsv-icon.ico")

    img = Image.open(src).convert("RGBA")
    arr = np.array(img).astype(np.float32)
    r, g, b, alpha0 = [arr[..., i] / 255.0 for i in range(4)]

    vmax = np.maximum(np.maximum(r, g), b)
    vmin = np.minimum(np.minimum(r, g), b)
    delta = vmax - vmin
    sat = np.where(vmax > 1e-6, delta / np.maximum(vmax, 1e-6), 0.0)
    val = vmax
    score = 0.72 * val + 0.28 * sat

    # Soft matte: remove dark background while keeping bright logo edges.
    matte = np.clip((score - 0.24) / 0.26, 0.0, 1.0)
    matte = np.maximum(matte, np.clip((val - 0.35) / 0.20, 0.0, 1.0))
    new_alpha = matte * alpha0

    out = np.zeros_like(arr)
    out[..., 0] = (r * 255).astype(np.uint8)
    out[..., 1] = (g * 255).astype(np.uint8)
    out[..., 2] = (b * 255).astype(np.uint8)
    out[..., 3] = np.clip(new_alpha * 255, 0, 255).astype(np.uint8)

    img_out = Image.fromarray(out, mode="RGBA")
    img_out.save(out_png)
    img_out.save(
        out_ico,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print(f"Saved transparent PNG: {out_png}")
    print(f"Saved ICO: {out_ico}")


if __name__ == "__main__":
    main()
