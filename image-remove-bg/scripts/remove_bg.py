#!/usr/bin/env python3
"""
Remove background from images using rembg.

Usage:
    python remove_bg.py <input> [output] [--model MODEL]

Examples:
    python remove_bg.py photo.jpg
    python remove_bg.py photo.jpg photo_nobg.png
    python remove_bg.py photo.jpg --model u2net_human_seg
"""

import argparse
import sys
from pathlib import Path

try:
    from rembg import remove
    from PIL import Image
except ImportError:
    print("Error: Required packages not installed.")
    print("Install with: pip install rembg pillow")
    sys.exit(1)


MODELS = {
    "u2net": "General purpose (default)",
    "u2netp": "Lightweight, faster",
    "u2net_human_seg": "Human segmentation",
    "u2net_cloth_seg": "Clothing segmentation",
    "silueta": "Similar to u2net, smaller",
    "isnet-general-use": "High quality general purpose",
    "isnet-anime": "Anime/illustration",
    "sam": "Segment Anything Model",
}


def remove_background(
    input_path: str,
    output_path: str | None = None,
    model: str = "u2net",
) -> Path:
    """Remove background from image.

    Args:
        input_path: Path to input image
        output_path: Path to output image (optional, auto-generated if not provided)
        model: rembg model to use

    Returns:
        Path to output image
    """
    input_file = Path(input_path)

    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    # Generate output path if not provided
    if output_path is None:
        output_file = input_file.with_stem(f"{input_file.stem}_nobg").with_suffix(".png")
    else:
        output_file = Path(output_path)

    # Ensure output is PNG (required for transparency)
    if output_file.suffix.lower() != ".png":
        output_file = output_file.with_suffix(".png")

    # Process image
    with Image.open(input_file) as img:
        output = remove(img, model_name=model)
        output.save(output_file)

    return output_file


def main():
    parser = argparse.ArgumentParser(
        description="Remove background from images using AI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Available models:
{chr(10).join(f'  {k:20} - {v}' for k, v in MODELS.items())}
"""
    )
    parser.add_argument("input", help="Input image path")
    parser.add_argument("output", nargs="?", help="Output image path (optional)")
    parser.add_argument(
        "--model", "-m",
        default="u2net",
        choices=MODELS.keys(),
        help="Model to use (default: u2net)"
    )

    args = parser.parse_args()

    try:
        output_path = remove_background(args.input, args.output, args.model)
        print(f"✅ Background removed: {output_path}")
    except FileNotFoundError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
