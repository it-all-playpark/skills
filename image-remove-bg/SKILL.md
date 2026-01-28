---
name: image-remove-bg
description: |
  Remove background from images using AI (rembg). Creates transparent PNG output.
  Use when: (1) user wants to remove/delete background from image, (2) needs transparent PNG,
  (3) keywords like "背景透過", "背景削除", "remove background", "transparent background",
  "切り抜き", "抜き出し", (4) file types: JPG, PNG, WEBP, TIFF, BMP, GIF.
---

# Remove Background

AI-powered background removal using rembg (U2-Net model).

## Quick Start

```bash
# Install (first time only)
pip install rembg pillow

# Basic usage
python scripts/remove_bg.py photo.jpg
# Output: photo_nobg.png

# Specify output
python scripts/remove_bg.py photo.jpg output.png

# Use specific model
python scripts/remove_bg.py photo.jpg --model u2net_human_seg
```

## Available Models

| Model | Use Case |
|-------|----------|
| `u2net` | General purpose (default) |
| `u2netp` | Faster, lightweight |
| `u2net_human_seg` | Human/portrait photos |
| `u2net_cloth_seg` | Clothing extraction |
| `isnet-general-use` | High quality general |
| `isnet-anime` | Anime/illustrations |

## Workflow

1. Check rembg installed: `pip show rembg`
2. If not installed: `pip install rembg pillow`
3. Run script with input image
4. Output is always PNG (transparency support)

## Script Location

`scripts/remove_bg.py` - Main background removal script
