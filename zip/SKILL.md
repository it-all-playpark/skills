---
name: zip
description: "Create zip archive from a directory. Use when: (1) user wants to compress a directory into a zip file, (2) needs to archive files for sharing or backup, (3) keywords like zip, compress, archive, bundle."
---

# Zip

Create a zip archive from a specified directory.

## Usage

```
/zip <directory> [--output <filename>] [--password <password>]
```

## Arguments

- `<directory>` (required): Path to the directory to archive
- `--output`, `-o`: Custom output filename (default: `<dirname>_<timestamp>.zip`)
- `--password`, `-p`: Password protect the archive

## Examples

```bash
# Basic usage - creates src_20250126_143022.zip
/zip ./src

# Custom output filename
/zip ./project --output release.zip

# Password protected archive
/zip ./documents --password secret123

# Combined options
/zip ./data -o backup.zip -p mypassword
```

## Implementation

Use the `zip` command:

```bash
# Basic
zip -r <output.zip> <directory>

# With password
zip -r -P <password> <output.zip> <directory>
```

Default output filename format: `<dirname>_<YYYYMMDD_HHMMSS>.zip`
