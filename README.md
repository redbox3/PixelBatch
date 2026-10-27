# PixelBatch

A desktop app for Windows and macOS that batch resizes, converts and renames images. It can also turn PDF pages and SVGs into images.

## Run it

```bash
npm install
npm start
```

## Build an installer

```bash
npm run dist:win
```

This makes `dist/PixelBatch Setup 1.0.0.exe` (installer) and a portable `.exe`.

To build the Mac `.dmg`, run `npm install` and then `npm run dist:mac` **on a Mac**. The image libraries are native, so each platform must be built on that platform. For a version you can share without Gatekeeper warnings, sign it with an Apple Developer ID.

## Features

**Input**
- Drag and drop files or folders anywhere on the window, or use **+ Files** / **+ Folder**. Subfolders are included unless you turn that off.
- Reads JPG, PNG, WebP, GIF (including animated), AVIF, TIFF, SVG and PDF (every page, or a range like `1-3, 5, 7-end`).
- SVG and PDF are rendered straight at the target size, so they stay sharp.

**Sizes and resizing**
- Any number of named sizes in each preset. Each ticked size gives its own output file. Leave the width or height blank to keep proportions.
- Quick-add list: 4K, Full HD, Instagram, Stories, OG/Facebook, X header, LinkedIn banner, YouTube thumbnail and more.
- Resize modes: *fit inside* (keeps the ratio), *pad to exact size* (keeps the ratio and fills with a background colour), *crop to fill* (with a centre, edge or smart focus), *stretch* (ignores the ratio), or *no resizing*.
- Option to block upscaling, plus a background colour or transparency.

**Formats and compression**
- JPG, PNG, WebP, AVIF, GIF, animated GIF, animated WebP, TIFF, BMP and ICO (multi-size Windows icons), or keep the source format.
- A quality slider, or a **target maximum file size**: the app finds the highest quality that fits. PNG and GIF reduce colours instead.
- PNG colour reduction (TinyPNG-style), lossless WebP, progressive JPG, GIF colours, dither and lossy GIF compression, TIFF compression.

**Contact sheet mode** combines images into grid images (JPG, PNG, WebP and the other formats). You set:
- columns, rows per sheet (0 puts everything on one sheet) and cell size in px
- gap, margin and background colour
- whether images fit inside their cell or are cropped to fill it
- an optional title, plus file-name captions with their own size and colour

When there are more images than fit, new sheets are started. A sheet that isn't full drops its empty rows.

**PDF mode** combines images into one PDF document. You set:
- page size: A3, A4, A5, Letter, Legal, Tabloid, or the page fitted to each image
- orientation: auto-rotate per image, portrait or landscape
- margins in mm
- layout: one image per page, or a grid (columns × rows, with a gap)
- whether images fit or are cropped to fill
- an optional title, captions and page numbers
- JPEG quality, maximum image resolution (dpi) and a lossless option

Multi-page PDFs and SVGs can go in as sources too. In both modes, a name pattern sets the file name (`{folder}`, `{page}`, `{date}`, `{n}` and others). You can make one file from all the images or one per source folder. The preview shows the sheet or PDF page that holds the selected image.

**Adjustments:** auto-rotate from EXIF, rotate, flip, black and white, sharpen, brightness and saturation.

**Watermark:** text or a logo image, 9 positions, opacity, and a size relative to the image width.

**Rename:** build names from tokens: `{name} {n} {n:3} {suffix} {size} {w} {h} {page} {folder} {date} {time} {ext} {fmt} {preset}`. You can also set a start number, change case (lower, UPPER, web-safe slug), swap spaces for dashes or underscores, and find/replace. A live example shows the result. **Rename only** mode copies (or moves) files without re-encoding them.

**Output:** a separate output folder for each preset. Options: rebuild the source folder structure, make a subfolder per size, choose what happens when a file exists (add a number, overwrite, skip), keep or strip metadata (EXIF, GPS), keep the original file dates.

**Preview:** side by side, a split slider, result only or original only, at fit or 100% zoom. It shows the output dimensions, format, real encoded file size, the % saved, the quality chosen for a target size, and the final file name. You can step through PDF pages and switch between preset sizes.

**Presets:** save, save as, duplicate, rename, delete, revert, and import/export as `.json` to share with colleagues. Presets are stored in the app's user-data folder. The starter presets include *Contact sheet 5 × 6* and *Images to PDF (A4)*. If you saved presets with an older version, add these with **⋯ → Add starter presets**.

Shortcuts: `Ctrl/Cmd+O` add files, `Ctrl/Cmd+Shift+O` add folder, `Ctrl/Cmd+Enter` process, `Ctrl/Cmd+S` save preset, arrow keys move through files, `Delete` removes the selected file from the list.

## Tests

```bash
npm test
```

This runs the processing engine against sample files in `test/in` (regenerate them with `node test/make-samples.js`). `node test/combine.js` builds contact sheets and PDFs and checks that the PDFs open. `npx electron test/smoke.js` and `npx electron test/smoke3.js` open the real UI, run batches and save screenshots to `test/out`.

## Licences

Built with Electron, [sharp](https://sharp.pixelplumbing.com/) (libvips, Apache-2.0) and [mupdf.js](https://mupdf.com/) (AGPL-3.0, used for PDF rendering). Using it yourself or inside your company is fine. Selling or distributing it closed-source would need a commercial MuPDF licence, or swapping PDF rendering to pdf.js.
