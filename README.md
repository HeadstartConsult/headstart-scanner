# Free Document Scanner (Headstart Consult CC)

A free, browser-based document scanner for www.headstartconsult.co.za. Visitors take or choose photos, the app finds the page edges, straightens and cleans the page, and saves several pages as one PDF. Everything runs in the visitor's browser. No server code, no accounts, no third-party scripts.

© Headstartconsult. All rights reserved.

## Repository layout

- `index.html` and `assets/` at the root: the landing page (from the launch graphics work). Its "Open the scanner" buttons link to `app/`.
- `app/`: the scanner itself, described below.

Nothing in this repository is linked to Netlify or any host. Pushing here does not deploy anything or use hosting credits.

## App files (in `app/`)

| File | Purpose |
|---|---|
| `index.html` | The scanner page |
| `app.js` | All scanner logic (edge detection, perspective fix, filters, PDF writer). No libraries. |
| `privacy.html` | Privacy notice (POPIA) and terms (ECT Act, CPA) |
| `sw.js`, `manifest.webmanifest`, `icon*.png`, `icon.svg` | Lets visitors install it like an app and use it offline |

Total size is about 100 KB (50 KB zipped).

## How to put it on your website

1. Upload the whole folder (the landing page from the launch graphics already sits at `/scanner/` and links here) to your host, for example to `public_html/scanner/app/`, so it opens at `https://www.headstartconsult.co.za/scanner/app/`.
2. The site must use HTTPS. Camera capture and offline mode need it.
3. Link to it from your menu, or embed it in an existing page:

```html
<iframe src="/scanner/app/" title="Free Document Scanner" style="width:100%;height:900px;border:0" allow="camera"></iframe>
```

4. The registration number and addresses come from the CIPC disclosure certificate of 19 October 2026.

Do not add Google Analytics, Facebook Pixel or chat widgets to the scanner page. The privacy notice says the page uses no tracking, and adding them would make that untrue.

## Cost review (nothing for Headstart to absorb)

| Item | Cost to Headstart Consult CC | Why |
|---|---|---|
| Image processing, edge detection, PDF creation | None | Runs on the visitor's own device |
| AI / OCR | None | Not used. Detection is plain on-device maths |
| SMS / WhatsApp / e-mail | None | Not used. "Share" opens the visitor's own apps |
| Storage of scans | None | Nothing is stored or uploaded |
| Third-party libraries or CDNs | None | No external scripts or fonts |
| Hosting bandwidth | Negligible | About 100 KB per first visit, then cached on the device. Falls within normal website hosting |

**Flag:** if you later add any paid feature (for example OCR text extraction, cloud storage, or e-mailing the PDF from a server), that would create a per-use cost. Under your rules it must then be charged per use or excluded from the free version.

## Automated steps (trigger, handover, where seen, how to proceed)

Every automated step reports in the same status box at the top of the page, with three lines: "Started by", "What happened" and "Your next step". The step pills (1 to 4) above it show where the visitor is.

| Automated step | What starts it | Handover | Where it is seen | How the visitor knows to proceed |
|---|---|---|---|---|
| Read photo | Visitor takes or chooses a photo | Passes the image to edge detection | Status box (with spinner) | Told to wait; moves on by itself |
| Edge detection | Photo finished loading | Shows the blue frame on the Check edges screen and waits | Status box (green if found, amber if not) | Told to check or drag the 4 corners, then tap "Crop page" |
| Straighten and Auto clean | Visitor taps "Crop page" | Shows the cleaned page on the Enhance screen and waits | Status box | Told to pick a filter, then tap "Add to document" |
| Next photo in batch | Visitor adds, skips or discards a page while more photos are queued | Opens the next photo and runs edge detection | Status box says "photo 2 of 3" | Same as edge detection |
| Create PDF | Visitor taps "Save PDF" | Browser download | Status box shows file name and size | Told where the file is saved and to delete pages on a shared device |

Nothing is sent anywhere automatically, and no step continues past a human check without the visitor tapping a button.

## South African legal check

| Law | How the scanner complies |
|---|---|
| POPIA (Act 4 of 2013) | Headstart does not collect or process the scanned personal information, because it never leaves the device. No cookies or tracking. Privacy notice names the responsible party, explains data subject rights and gives the Information Regulator's contact details. Pages are kept in memory only and can be deleted with one tap. |
| ECT Act (Act 25 of 2002) | Notice that a scan is an electronic copy and does not replace an original or certified copy. Section 43 style supplier details (name, registration number, address, contact) are shown in the privacy notice. |
| Consumer Protection Act (Act 68 of 2008) | Free "as is" disclaimer limited to what the law allows, without excluding non-waivable rights. |
| Copyright Act and Cybercrimes Act | Visitors are told to scan only documents they may copy and that altering documents to deceive is an offence. |

This is a design check, not legal advice. Have your legal adviser review `privacy.html` before launch.

## Known limits of the prototype

- Edge detection works best with a light page on a darker background. When it cannot find the page, it says so and the visitor drags the corners.
- Very long batches (more than about 30 pages) may be slow on older phones. Choosing "Small file" quality helps.
- iPhone HEIC photos are converted to JPEG by iOS when chosen through the browser, so they work.
