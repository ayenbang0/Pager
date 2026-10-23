# Canvas block: agent contract

The Canvas block is a whiteboard. Its main-process handler (`desktop/electron/blocks/canvas.cjs`) owns the document of record
and exposes four agent hooks, all reached through `d.block('canvas', method, args)` (window) or the same names from the agent
tools: **`read`** (canvas_read), **`shot`** (canvas_shot), **`edit`** (canvas_edit), **`history`** (canvas_history).

Every method takes an optional `id`. Without it the last opened canvas is used (`main` if none was opened). A pane opens a canvas
with `command` JSON `{ "id"?: string, "path"?: string }` (pane kind `block:canvas`): `id` names `<dataDir>/canvases/<id>.canvas.json`
(`id` matches `[A-Za-z0-9_-]{1,40}`), `path` is an absolute `.json` file anywhere. Images live next to the file in `<id>.blobs/`.

All coordinates are world units (the canvas is infinite; +x right, +y down). Colours are `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
`rgba()`, `hsl()`, `hsla()`, a plain colour name, `transparent`, or `auto` (the theme's ink colour: use it for default strokes so
drawings follow light and dark themes).

Failures throw an `Error` with a message (and `code`: `BAD_ARGS`, `TOO_BIG`, `NOT_OPEN`, `NOT_FOUND`, `SHOT_FAILED`). Validation
problems of an `edit` are **not** thrown: they come back as `{ ok: false, errors }` and nothing is changed.

## read

`read { id?, ids?: string[], pts?: boolean }` returns

```json
{ "id": "main", "name": "Untitled canvas", "seq": 12, "view": { "x": -120, "y": -80, "zoom": 1 },
  "settings": { "grid": true, "snap": true, "hand": false }, "count": 3,
  "bounds": { "x": 0, "y": 0, "w": 420, "h": 260 }, "shapes": [ ... ] }
```

`shapes` is ordered back to front. `ids` returns only those shapes (`count` and `bounds` still describe the whole canvas).
Ink points are replaced by `ptCount` (and `truncated: true` is set) when `pts: false` or when the reply would pass ~2 MiB.
`seq` increases with every accepted change: pass it back as `expectSeq` to `edit` to detect races.

## shot

`shot { id?, fit?: "view" | "content", width?, height?, scale? }` returns `{ id, mime: "image/png", dataUrl, width, height }`.
The window renders the PNG on request (an event round trip), so the canvas must be open in a window; otherwise it fails with
`NOT_OPEN` after 10 s. `fit: "view"` (default) is what the user sees now; `"content"` frames every shape. `width`/`height`
are integers 64..4096 (aspect ratio kept), `scale` is 0.25..3. Replies over 14 MiB are refused.

## edit

`edit { id?, ops: Op[], label?, expectSeq? }`: up to 200 operations, applied **atomically** in order (later ops see earlier ones).
Success: `{ ok: true, seq, created: string[], changed: string[], removed: string[], results: [...], count }`.
Failure: `{ ok: false, seq, errors: [{ index, error }], results }` (`index` -1 = a whole-call limit, `conflict: true` when
`expectSeq` no longer matches). The window shows the change live, highlights the touched shapes and records it in its undo
history as `Agent: <label>`; `label` defaults to a summary like `Agent: +3 ~1`.

| op | fields | notes |
|---|---|---|
| `add` | `shape` or `shapes` (1..500) | `id` optional (generated). Shapes without `x`/`y` are stacked below the existing content. |
| `update` | `id` or `ids`, `set: {fields}` | Any field of the shape except `id` and `type`. Text is re-measured. |
| `remove` | `ids` / `id`, or `group` | Arrows bound to a removed shape keep their last position, unbound. |
| `group` | `ids` (>= 2 units), `id?` (new group id) | Groups nest up to 8 deep. Selecting any member selects the group. |
| `ungroup` | `id` (a group id or a shape id) or `ids` | Removes the outermost group. |
| `layout` | `kind`: `grid` (default) `row` `column` `tree`; `ids?` (default all), `gap?` (40), `columns?`, `dir?`: `down` (default) `right` | `tree` reads parent/child from bound arrows; without arrows it falls back to a grid. Groups move as one. Lines and arrows are not nodes: bound ones follow. |
| `align` | `ids`, `to`: `left center right top middle bottom` | Aligns to the selection bounds. |
| `distribute` | `ids` (>= 3), `axis`: `x` or `y` | Equal gaps; the outer two stay. |
| `order` | `ids`, `to`: `front back forward backward` | z-order. |
| `clear` | | Removes every shape. |

### Shapes

Common fields: `id`, `type`, `x`, `y`, `w`, `h`, `angle` (radians about the centre), `stroke` (default `auto`), `fill`
(default `transparent`), `sw` (stroke width 0..40, default 2), `dash` (`solid` `dashed` `dotted`), `opacity` (0..1),
`rough` (hand-drawn wobble stroke), `seed` (wobble seed), `g` (group ids, outermost last), `locked`, `name` (free label for you).
Unknown fields are rejected.

- `rect`: `round` (rounded corners, default true), optional label `text`, `size`, `font`. Default 140x90.
- `ellipse`, `diamond`: optional label `text`, `size`, `font`. Defaults 140x90 and 140x100.
- `sticky`: `text`, `size` (default 20), `font` (default `hand`), `fill` is the note colour (default `#fde68a`). Default 180x150.
- `text`: `text` (<= 20000 chars), `size` (4..600, default 20), `font` (`sans` `hand` `mono`), `align`, `fw` (fixed width: wraps to `w`). Size is measured when omitted.
- `line`, `arrow`: either `pts: [[x, y], ...]` (2..4000 points, relative to `x`,`y`; absolute when `x`,`y` are omitted) or
  `x1,y1,x2,y2`. `head` (end) and `headS` (start): `none arrow triangle dot bar` (arrow defaults to `arrow`, line to `none`).
  `bend` (-2..2, two-point shapes) curves it. **Bound endpoints:** `from`/`to` (shape ids) attach the start/end to a shape; the
  arrow is routed to the shape edge and follows it when it moves. (`bind: { s?, e? }` is the stored form.)
- `ink`: freehand stroke, `pts: [[x, y, pressure 0..1], ...]`, `sw` is the nominal width; rendered as a smooth variable-width outline.
- `image`: `hash` (from `putBlob`), `mime`, `nw`/`nh` natural size, `x y w h`. Size defaults to the natural size capped at 480.

Example:

```json
{ "ops": [
  { "op": "add", "shapes": [
    { "id": "api", "type": "rect", "x": 0, "y": 0, "w": 140, "h": 60, "text": "API", "fill": "rgba(61,111,255,.22)", "stroke": "#3d6fff" },
    { "id": "db", "type": "ellipse", "x": 0, "y": 160, "w": 140, "h": 60, "text": "Database" } ] },
  { "op": "add", "shape": { "type": "arrow", "x1": 0, "y1": 0, "x2": 1, "y2": 1, "from": "api", "to": "db" } },
  { "op": "layout", "kind": "tree" } ],
  "label": "Agent: architecture sketch" }
```

### Limits

5000 shapes per canvas, 4000 points per line/ink shape and 400000 in total, 20000 characters per text, coordinates within
+-1e6, sizes within 0..1e5, 200 operations per call, 120 characters per `name`/`label`, images 25 MiB (PNG, JPEG, GIF, WebP,
checked by magic bytes).

## history

`history { id?, limit? (1..200, default 20) }` returns `{ id, seq, edits }`, oldest first, newest last:

```json
{ "n": 41, "seq": 12, "ts": "2026-10-22T10:00:00.000Z", "source": "agent", "label": "Agent: +3 ~1",
  "created": ["api"], "changed": ["db"], "removed": [] }
```

`source` is `agent`, `user` (a window saved a change), or `disk` (the file was edited outside Pager and merged). Id lists are
capped at 200 (`truncated: true`). The last 50 entries survive a restart.

## Other methods (used by the window)

`open`, `save` (with the `seq` conflict check), `saveView`, `flush`, `close`, `list`, `create`, `rename`, `remove` (moves the
file to `.trash/`), `putBlob { id?, mime, data: base64 } -> { hash, mime, bytes }`, `getBlob { id?, hash }`, `shotReply`, `status`.
`putBlob` is also how an agent adds an image: upload, then `edit` an `image` shape with the returned `hash`.

Persistence: edits are written atomically (temp file + rename) 400 ms after the last change and on close. If the file changes
on disk behind Pager's back (mtime), the change is three-way merged by shape id and announced to the window. Set
`PAGER_CANVAS_EPHEMERAL=1` (or open with `ephemeral: true`) to keep a canvas in memory only; `PAGER_CANVAS_DIR` overrides the folder.

## Events (handler -> window)

`changed { id, source, label, seq, ids, doc? }` (agent edit, other window's save, disk merge; `doc` omitted for very large
canvases), `shot { req, id, fit, width, height, scale }`, `error { id, message }`.
