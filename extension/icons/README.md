# Icons

`icon.svg` is the source (accent-orange rounded square with a flame mark).

`16.png`, `32.png`, `48.png`, `128.png` are generated placeholders rasterized
directly from a small Node script (no image-editing tools were available in
the build environment, so the PNGs were produced by hand-encoding raw RGBA
scanlines + zlib-deflating them into a minimal valid PNG container — see the
shape logic mirrored from `icon.svg`). They render correctly (verified with
`sips`/`file`) but are approximations of the SVG, not a pixel-perfect export.

Before a real Web Store submission, replace these four PNGs with a proper
export of `icon.svg` at each size (e.g. via any vector tool, or
`rsvg-convert -w SIZE -h SIZE icon.svg -o SIZE.png` if available), or commission
real artwork. Required sizes, per `manifest.json`: 16, 32, 48, 128 (px, square).
