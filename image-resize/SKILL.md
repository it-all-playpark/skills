---
name: image-resize
description: |
  Resize images using vips CLI with support for resolution, scale, and dimension-based resizing.
  Use when: (1) user wants to resize/scale images, (2) needs to change image dimensions,
  (3) keywords like "resize", "scale", "shrink", "enlarge", "smaller", "bigger", "dimensions",
  (4) file types: JPG, PNG, WEBP, AVIF, TIFF, BMP, GIF.
---

# Image Resize Skill

Resize images using vips CLI. Supports three modes:
- **Resolution**: Exact width x height
- **Scale**: Percentage-based (0.5 = 50%, 2 = 200%)
- **Dimension**: Width or height with aspect ratio preservation

## Usage

```bash
scripts/resize_image.sh <input> -o <output> [options]
```

## Options

| Flag | Description |
|------|-------------|
| `-W, --width` | Target width (px) |
| `-H, --height` | Target height (px) |
| `-s, --scale` | Scale factor (0.5 = 50%) |
| `-q, --quality` | Output quality 1-100 (default: 90) |

## Examples

```bash
# Exact resolution
scripts/resize_image.sh photo.jpg -o out.jpg -W 1920 -H 1080

# Width only (aspect ratio preserved)
scripts/resize_image.sh photo.png -o thumb.png -W 400

# Scale to 50%
scripts/resize_image.sh large.jpg -o small.jpg -s 0.5

# Scale to 200% with max quality
scripts/resize_image.sh icon.png -o icon_2x.png -s 2 -q 95
```

## Requirements

- libvips installed (`brew install vips` on macOS)

## Notes

- Output format determined by file extension
- Supported formats: JPG, PNG, WEBP, AVIF, TIFF, GIF
- Quality scale: 1-100 (higher is better), default 90
