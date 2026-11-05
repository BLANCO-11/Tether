/**
 * Turns a raw model id (e.g. `RadixArk/Qwen3.8-27B-NVFP4`) into the name people see in the Forge composer.
 * The raw id stays available as a tooltip.
 */

const FAMILIES = ["gpt", "glm"];

export function prettyModelName(id: string): string {
  try {
    let s = String(id ?? "").trim();
    // Drop the org prefix: keep the text after the last "/".
    s = s.slice(s.lastIndexOf("/") + 1);
    // Strip trailing quantisation/format tags and date/build stamps, until nothing changes.
    for (;;) {
      const next = s.replace(/[-_](NVFP4|FP8|FP4|AWQ|GPTQ|GGUF|INT4|INT8|BF16)$/i, "").replace(/[-_]\d{4,8}$/, "");
      if (next === s || next === "") break;
      s = next;
    }
    const raw = s.split(/[-_]+/).filter(Boolean);
    // Merge runs of 2+ single digits into one dotted version token (5, 5 -> 5.5).
    const tokens: string[] = [];
    for (let i = 0; i < raw.length; ) {
      if (/^\d$/.test(raw[i])) {
        let j = i;
        while (j < raw.length && /^\d$/.test(raw[j])) j++;
        if (j - i >= 2) {
          tokens.push(raw.slice(i, j).join("."));
        } else {
          tokens.push(raw[i]);
        }
        i = j;
      } else {
        tokens.push(raw[i]);
        i++;
      }
    }
    // Family prefixes go upper case and glue on a following version token.
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (FAMILIES.includes(t.toLowerCase())) {
        const up = t.toUpperCase();
        if (i + 1 < tokens.length && /^\d/.test(tokens[i + 1])) {
          out.push(`${up}-${tokens[i + 1]}`);
          i++;
        } else {
          out.push(up);
        }
      } else if (/^[a-z]+$/.test(t)) {
        out.push(t.charAt(0).toUpperCase() + t.slice(1));
      } else {
        out.push(t);
      }
    }
    const result = out.join(" ");
    if (result) return result;
    return String(id ?? "").trim() || "Model";
  } catch {
    return String(id || "Model");
  }
}
