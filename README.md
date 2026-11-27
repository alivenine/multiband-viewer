# Multiband Viewer

View multiband images of paintings (visible, IR, UV, X-ray, false color …) side by side.
Zooming or panning one image moves all of them to the same spot on the painting. Includes
numbered points, notes, arrows, boxes and text for client presentations.

One codebase ships three ways:

| Target  | How it runs | Size |
|---------|-------------|------|
| Web     | static files (`dist/`), opened in Chrome / Edge / Safari / Firefox | ~170 KB |
| macOS   | Tauri app using the built-in WebKit | ~5 MB |
| Windows | Tauri app using the built-in WebView2 (Edge) | ~4 MB installer |

Electron was not used: Tauri relies on the webview the OS already has, so the app is
about 30× smaller and uses much less RAM.

**Privacy:** everything runs on your computer, and no image data is uploaded. The web version is
still static files, so hosting it doesn't send images anywhere. Production builds also carry a
Content-Security-Policy that stops the page from connecting anywhere except its own files, so the
browser itself would block an upload. The app shows this in a **🔒 Privacy** note in the sidebar.

## Download
- **Web:** open https://multiview.alivenine.fyi, nothing to install. Or host your own copy for free (see
  [Web deployment](#web-deployment)).
- **macOS and Windows:** installers are on the [Releases](https://github.com/alivenine/multiband-viewer/releases) page
  (`.dmg` for Mac, Intel and Apple silicon; `.exe` or `.msi` for Windows).
- The apps aren't code-signed. On a Mac, the first open is blocked: go to **System Settings → Privacy & Security**,
  click **Open Anyway**, then open the app again. On Windows, SmartScreen may say "Windows protected your PC": click
  **More info**, then **Run anyway**.

## Supported files
- TIFF 8 / 16 / 32-bit float (with its own LZW decoder: the `geotiff` library's version hangs on standard LZW files that fill the full code table), gray or RGB, uncompressed / LZW / Deflate / PackBits / JPEG, striped or tiled, BigTIFF.
  16-bit and float data get an automatic stretch from the 0.05–99.95 percentiles.
- JPEG / PNG / WebP use the browser decoder, which holds the whole image in RAM. For very large files
  (more than ~500 MP), TIFF is better.

## How it stays fast with gigapixel files
On first open, each image streams through a background worker in 512-row bands and becomes a
JPEG tile pyramid. The tiles are stored in the browser's private disk storage (OPFS), so memory
stays at a few hundred MB even for multi-gigapixel TIFFs. The screen only loads the tiles it
shows. If you reopen the same file, it loads instantly from the cache. To manage the cache,
use **Local cache** in the sidebar.

Measured on an M-series Mac: a 300 MP 16-bit RGB TIFF (1.8 GB) imports in about 15 s, and
re-opening it takes under 1 s.

## Alignment (registration)
Each image is aligned to the **reference** image. The visible image goes in panel 1 and becomes the reference.
It's found by file name: `visible`, `vis`, `white`, `white light`, `D65`, `halogen`, `RGB` or `color`. Names that also
contain `IR`, `UV`, `UVF`, `IRR`, `IRFC`, `fluo`, `x-ray`, `raking` or `transmitted` are skipped. If there's no visible
image, the first image opened is the reference. You can always change it with **Set reference**.
- Opening images doesn't align them, so they open quickly. Until you align them, each one is placed by scaling it
  to fit the reference. Click the blue **Auto-align all** button (next to IMAGES) when you need exact alignment.
- **Auto:** builds gradient images (which work across IR / UV / visible), searches scale and shift at coarse
  resolution, then refines rotation, scale and shift with ECC. On test data, the error was below 0.3 px
  at full resolution.
- **Manual:** click a feature in the reference, then the same feature in the other image. Do this for 2 or
  more pairs, as far apart as possible, then click **Apply**.
- **Full align** (per image, or **Full** next to Auto-align all): slower, for difficult bands.
  - It always runs the quick method first. If that result is confident, Full only fine-tunes it.
  - Otherwise it searches rotation ±8°, scale ±15% and shift, then matches image content with
    mutual information, a method that works even when the bands look completely different.
  - This fixed IR transmission (`P1 IRT`), where Auto settled on a wrong 5.7° rotation.
- **↶ Undo align** restores the previous alignment for that image, as many steps back as you need.
  If an alignment fails or lands far from the default fit (more than 10° rotation, more than 30% scale,
  or the center moved by more than 25%), it's rejected and the image keeps its current placement.
- **Verified:** every result is then checked by block-matching about a thousand small patches across the image and
  refitting with outliers removed. Regions that move differently, like the stretcher-bar shadow in transmitted light,
  the background at another depth or lamps in the frame, are voted out. The card shows **verified ✓**. Hover it to
  see how much the patches disagree. If the check fails, the card says **not verified**.
- **Via a sibling band:** a band that can't be verified against the reference, typically IR transmitted (`IRT`) against
  visible, is aligned to the closest-named verified band instead (`IRT` to `IR`: same wavelength and focus), then the
  two alignments are chained. The card shows **Aligned via P2 IR.JPG**.
- **Compare** (toolbar, or `C` to cycle) overlays the reference on every panel so you can check alignment by eye:
  **Swipe** follows the cursor at the same spot in every panel, **Flicker** alternates the two, and **Difference** shows
  misalignment as doubled edges (most useful for bands with similar tones).
- For very low-detail bands, such as IR of dye-based paint, use **Manual align**.
- **Benchmark:** `node bench/run.mjs Demo-P2 [--full] [--only IRT] [--via " IR.JPG"]` runs the alignment on a folder
  and measures the remaining error at full resolution with an independent patch matcher. It also runs a synthetic pair
  with a known warp. Set `EVAL=x,y,w,h` (overview px) to measure only on the painting.

## Using it
- Open images: use the button, or drag and drop. Pick a layout from the toolbar. Each panel has a
  dropdown to choose its image.
- The **Navigator** at the top of the sidebar shows the whole reference image. Click or drag on it to move, scroll on it or use the slider / ± to zoom.
- Scroll or pinch to zoom. Drag to pan. Right-drag or hold Space to pan in any tool.
- A cyan crosshair in the other panels shows where your cursor is.
- **RGB** button (or `I`): shows `R G B` under the cursor for every panel, at the same spot on the painting. These are the
  8-bit display values. They are usually within ±1 of the file, and off by up to ±5 on very fine texture (tiles are stored as
  high-quality JPEG). For 16-bit files, they are the values after the auto-stretch, not the raw 16-bit numbers.
- Tools: `V` select/pan, `N` numbered point, `T` text, `A` arrow, `R` box, `E` circle, `P` pen.
  Shift draws a square or circle.
- `C` cycles Compare (swipe / flicker / difference with the reference).
- `Del` deletes, `Ctrl/⌘+Z` undoes, `0` fits, `1` shows 1:1, `F` starts presentation mode, `Ctrl/⌘+S` saves the project.
- Notes for numbered points go in the sidebar. To print them next to the points, tick **show on image**.
- **Export PNG** saves the current layout with markup. **Save** writes a `.mbv.json` project file
  (alignment, markup, layout). If the images are still cached, **Load** reopens them straight away.
  Otherwise it asks you to open them again.
- Click a panel with **Select** and the sidebar scrolls to that image's card, outlined in blue, so you can adjust it straight away.
- **Close all** (below the image list) closes every image. They stay in the local cache, so reopening is instant.
- **Local cache** shows the 6 most recent files; click **Show all** for the rest. Unfinished imports, from a cancelled or crashed import, are cleaned up automatically.
- Images import 3 at a time and the rest wait in a queue. This keeps memory use reasonable when you open a dozen large bands at once.
- Each image has brightness / contrast / invert controls. These change only the display, not the data.

## Build the Windows app on a Windows PC
1. Copy this folder to the PC. You can leave out `node_modules` and `src-tauri/target`.
2. Double-click **`BUILD-WINDOWS.bat`**.
   - The first run installs the C++ build tools, Node.js and Rust with `winget`. It needs internet and about 3 GB,
     takes 10–30 minutes, and Windows will ask you to approve (UAC) once.
   - Later runs only rebuild, in about 1–3 minutes.
3. When it finishes, the `installers` folder opens. It contains:
   - `Multiband Viewer_x.y.z_x64-setup.exe`: the normal installer
   - `.msi`: an installer for IT deployment
   - `MultibandViewer-portable.exe`: runs without installing (Windows 10/11)

Only the installer or the portable exe needs to go to other PCs. The build tools stay on the build PC.
The app isn't code-signed, so Windows SmartScreen may say "Windows protected your PC". Click
**More info**, then **Run anyway**.

## Web deployment
Live at **https://multiview.alivenine.fyi**, served by Cloudflare Pages. To publish an update:
```bash
npm run deploy
```
`public/_headers` sends the same no-upload Content-Security-Policy as an HTTP header.

### Host your own copy for free
The web app is only static files, and all image processing happens in the visitor's browser, so it runs on
Cloudflare's **free plan** (Pages, or Workers static assets). Static requests and bandwidth are free and unlimited
there. You pay nothing for storage either, because images are never uploaded.

Either connect your fork in the Cloudflare dashboard (**Workers & Pages → Create → Pages → Connect to Git**,
build command `npm run build`, output directory `dist`), or deploy from your computer:
```bash
npx wrangler login
npx wrangler pages project create my-multiband-viewer
npm run build && npx wrangler pages deploy dist --project-name my-multiband-viewer
```
Any other static host (GitHub Pages, Netlify, your own web server) works too. Serve `dist/` with the
headers from `public/_headers` to keep the no-upload policy.

## Develop
```bash
npm install
npm run dev          # web app at http://localhost:5173
npm run build        # static web build in dist/
npm run tauri dev    # desktop app (needs Rust: https://rustup.rs)
npm run tauri build  # installer for the current OS
```
Windows installers have to be built on Windows. Alternatively, push a `v*` tag (or run the workflow
manually) and `.github/workflows/build.yml` builds the macOS (universal) and Windows installers.

The web version needs `https://` or `localhost`, because the disk cache (OPFS) requires a secure origin.
If that cache isn't available, tiles are kept in RAM instead.

## License

MIT, see [LICENSE](LICENSE).
