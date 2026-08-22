# DZ Drop Zone — what's outstanding

Last updated after the folder wiring landed (PR #9, `6f6f5f0`).
Nothing below is started. Nothing below is urgent.

## State of things right now

- Site live at **dzdropzone.com**, HTTPS enforced.
- All three apps file into the connected folder (`dzsave.js` → `folder.js`).
- One branch (`main`). No stale labels, nothing pending review.

HTTPS mattered for more than the padlock: `crypto.subtle` only exists in a
secure context, so `.dzvid` fingerprinting was silently falling back to
name-and-size matching over plain HTTP, and the fast multi-threaded ffmpeg
core needs cross-origin isolation. Both work properly now.

## Code

**`Videos/Converted/` for DZVidStitch.** Reopening a project re-converts
clips it already converted once. Keep the converted file next to the
original and match it back on reopen, so the second open is instant.

**Remove originals after conversion.** Wanted, and reasonable — but be
honest in the UI about what was actually done. A remux is lossless and the
original is genuinely redundant; a re-encode is not, and deleting the
original there is destroying quality the user can't get back. Those two
cases must not be offered with the same wording.

**Two-way rename sync.** Designed, not built. Rename in the folder → the
project follows; rename in the app → the file follows. The fingerprint
makes it possible.

**Tidy names from EXIF.** `detect.js` already reads the date and camera.

> Hold the last two until the folder has seen real daily use. Both move a
> user's actual files on disk based on inference. Everything else on this
> list fails by not happening; those two fail by doing the wrong thing to
> something irreplaceable.

## Operational — clicking, not code

- Resend verification for **dzdropzone.com**, and set `MAIL_DOMAIN` on the
  Worker (it currently falls back to `dzdocu.com`).
- A Cloudflare **rate-limiting rule** on the email Worker. The origin check
  stops another *website* using it; it does not stop a person with curl.
- **Old-domain redirects.** Stubs and the `sw.js` kill switch are written
  and tested — they're in `dzdropzone-later.zip`, not in this repo yet.

## Wanted, not yet specced

- An image editor (lightweight GIMP/Photoshop), an audio editor, and DZPDF.
- The vintage stack for the top of the site — record player, tape deck, CD
  player, the way a hi-fi was stacked in the 80s/90s.
- More cozy viewing areas, in the spirit of the Drive-In.
