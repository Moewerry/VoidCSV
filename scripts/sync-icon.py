from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PNG = ROOT / "web" / "public" / "voidcsv.png"
ICO = ROOT / "web" / "public" / "voidcsv.ico"
BUILD_ICO = ROOT / "build" / "icon.ico"
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    if not PNG.exists():
        raise SystemExit(f"icon source not found: {PNG}")

    img = Image.open(PNG).convert("RGBA")
    if min(img.size) < 256:
        img = img.resize((512, 512), Image.Resampling.LANCZOS)

    BUILD_ICO.parent.mkdir(parents=True, exist_ok=True)
    img.save(ICO, format="ICO", sizes=SIZES)
    img.save(BUILD_ICO, format="ICO", sizes=SIZES)
    print(f"saved {ICO}")
    print(f"saved {BUILD_ICO}")


if __name__ == "__main__":
    main()
