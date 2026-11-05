/**
 * Keep images small enough for the AI gateway (2026-10-12).
 *
 * The failure: a person attached an 800 KB PNG, Forge read it, and pi sent it at full size (pi only shrinks images
 * past 4.5 MB). The gateway in front of the model refuses any request over about 1 MB with "413 Request Entity Too
 * Large", and because the image stays in the conversation, EVERY later turn was refused too, even "hello".
 *
 * Two layers:
 *   1. tool_result: an image a tool returns is shrunk once, before it is stored in the conversation, to at most
 *      MAX_SIDE pixels and MAX_BYTES of base64. Forge is told it saw a smaller copy; the file on disk is unchanged.
 *   2. before_provider_request: if a request is still too large (several images, or a conversation from before this
 *      existed), the OLDEST images are replaced with a line of text until it fits. The newest image is kept.
 *
 * Load with: pi -e ./pi-extensions/image-budget.js
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_SIDE = 1280;
const MAX_BYTES = 350 * 1024;
/** What a whole request may weigh, under the gateway's ~1 MB limit with room for the text. */
const REQUEST_BUDGET = 900 * 1024;
const IMAGE_TYPES = new Set(["image_url", "input_image", "image"]);

let resizer;
async function loadResizer() {
  if (resizer !== undefined) return resizer;
  try {
    // pi's own resizer (Photon). Not in the package's exports, so it is loaded by path from the running pi.
    const dist = dirname(realpathSync(process.argv[1]));
    resizer = (await import(pathToFileURL(join(dist, "utils/image-resize.js")).href)).resizeImage;
  } catch {
    resizer = null;
  }
  return resizer;
}

/** Each image part of a provider payload, oldest first, with how to replace it. */
function imageParts(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (item && typeof item === "object" && IMAGE_TYPES.has(item.type)) out.push({ list: node, index: i });
      else imageParts(item, out);
    });
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) imageParts(v, out);
  }
  return out;
}

export default function (pi) {
  pi.on("tool_result", async (event) => {
    const images = (event.content || []).filter((c) => c && c.type === "image" && typeof c.data === "string");
    if (!images.some((c) => c.data.length > MAX_BYTES)) return;
    const resize = await loadResizer();
    const content = [];
    for (const c of event.content) {
      if (!(c && c.type === "image" && typeof c.data === "string" && c.data.length > MAX_BYTES)) {
        content.push(c);
        continue;
      }
      const small = resize ? await resize(c, { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, maxBytes: MAX_BYTES }).catch(() => null) : null;
      if (small && small.data.length <= MAX_BYTES) {
        content.push({ type: "image", data: small.data, mimeType: small.mimeType });
        content.push({
          type: "text",
          text: `(You are seeing a smaller copy, ${small.width}x${small.height}. The file itself is ${small.originalWidth}x${small.originalHeight} and unchanged; work on the file with code.)`,
        });
      } else {
        content.push({
          type: "text",
          text: "(This image is too large to show you. The file is unchanged; inspect or change it with code, for example Python with Pillow.)",
        });
      }
    }
    return { content };
  });

  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;
    let size = JSON.stringify(payload).length;
    if (size <= REQUEST_BUDGET) return;
    const parts = imageParts(payload);
    // Oldest first; the newest image is the one the person is talking about, so it goes last, if at all.
    for (let i = 0; i < parts.length && size > REQUEST_BUDGET; i++) {
      const { list, index } = parts[i];
      const before = JSON.stringify(list[index]).length;
      list[index] = { type: "text", text: "(An earlier image was removed here to keep the request small enough.)" };
      size -= before - JSON.stringify(list[index]).length;
    }
    return payload;
  });
}
