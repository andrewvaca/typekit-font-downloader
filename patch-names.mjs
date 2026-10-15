// Rewrites the `name` table (and OS/2 / head style bits) of an sfnt font.
//
// Adobe Typekit / Adobe Fonts serve web fonts with a blanked name table
// (family = "", subfamily = "Regular", full/postscript = "-"). That is why
// they install into Font Book with no name and every weight shown as
// "Regular". We rebuild the name table from the metadata the CSS gives us
// (family, weight, style), patching only the `name`, `OS/2` and `head`
// tables and leaving the glyph outlines and layout tables untouched.

import fs from "fs";

const WEIGHT_NAMES = {
    100: "Thin",
    200: "Extra Light",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "Semi Bold",
    700: "Bold",
    800: "Extra Bold",
    900: "Black",
};

const pad4 = (n) => (n + 3) & ~3;

// sfnt checksum: sum of uint32s over the 4-byte-aligned table region.
function checksum(buf, offset, length) {
    let sum = 0;
    const end = offset + pad4(length);
    for (let i = offset; i < end; i += 4) {
        const v =
            ((buf[i] << 24) |
                ((buf[i + 1] || 0) << 16) |
                ((buf[i + 2] || 0) << 8) |
                (buf[i + 3] || 0)) >>>
            0;
        sum = (sum + v) >>> 0;
    }
    return sum >>> 0;
}

function buildNameTable(records) {
    // Directory must be sorted by platform/encoding/language/nameID.
    records = records
        .slice()
        .sort(
            (a, b) =>
                a.platformID - b.platformID ||
                a.encodingID - b.encodingID ||
                a.languageID - b.languageID ||
                a.nameID - b.nameID
        );

    const encoded = records.map((r) => {
        if (r.platformID === 3) {
            const b = Buffer.from(r.value, "utf16le");
            b.swap16(); // UTF-16BE
            return b;
        }
        return Buffer.from(r.value, "latin1"); // Mac Roman (ASCII-safe)
    });

    const count = records.length;
    const recordsSize = count * 12;
    const headerSize = 6 + recordsSize;
    const storage = Buffer.concat(encoded);

    const table = Buffer.alloc(headerSize + storage.length);
    table.writeUInt16BE(0, 0); // format 0
    table.writeUInt16BE(count, 2);
    table.writeUInt16BE(headerSize, 4); // stringOffset

    let strOffset = 0;
    for (let i = 0; i < count; i++) {
        const r = records[i];
        const off = 6 + i * 12;
        table.writeUInt16BE(r.platformID, off);
        table.writeUInt16BE(r.encodingID, off + 2);
        table.writeUInt16BE(r.languageID, off + 4);
        table.writeUInt16BE(r.nameID, off + 6);
        table.writeUInt16BE(encoded[i].length, off + 8);
        table.writeUInt16BE(strOffset, off + 10);
        strOffset += encoded[i].length;
    }
    storage.copy(table, headerSize);
    return table;
}

// "source-code-pro" -> "Source Code Pro" for a readable Font Book entry.
function humanize(slug) {
    return slug
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

// Build the name records for both Mac (1,0,0) and Windows (3,1,0x409).
function nameRecords(rawFamily, weight, style) {
    const family = humanize(rawFamily);
    const italic = /italic|oblique/i.test(style);
    const weightName = WEIGHT_NAMES[weight] || "Regular";

    // Full typographic style, e.g. "Light Italic", "Bold", "Regular".
    let typoStyle = weightName;
    if (italic) typoStyle = weightName === "Regular" ? "Italic" : `${weightName} Italic`;

    // RIBBI grouping: each weight is its own legacy family, pairing its
    // upright + italic, so old apps still see a valid 4-member family.
    const legacyFamily = weightName === "Regular" ? family : `${family} ${weightName}`;
    const legacySub = italic ? "Italic" : "Regular";

    const fullName = `${family} ${typoStyle}`;
    const psName = `${family}-${typoStyle}`.replace(/[^A-Za-z0-9-]/g, "");

    const values = {
        1: legacyFamily,
        2: legacySub,
        4: fullName,
        6: psName,
        16: family, // Typographic family -> groups all weights under one menu
        17: typoStyle, // Typographic subfamily
    };

    const records = [];
    for (const [id, value] of Object.entries(values)) {
        const nameID = Number(id);
        records.push({ platformID: 1, encodingID: 0, languageID: 0, nameID, value });
        records.push({ platformID: 3, encodingID: 1, languageID: 0x409, nameID, value });
    }
    return { records, italic, isBold: weight >= 700 };
}

export function patchFont(filepath, { family, weight, style }) {
    // Variable fonts report a range ("300 900"); take the first value and
    // clamp to a sane default if it is not a usable weight number.
    let w = parseInt(String(weight), 10);
    if (!Number.isFinite(w) || w < 1 || w > 1000) w = 400;
    weight = w;

    const buf = fs.readFileSync(filepath);

    const numTables = buf.readUInt16BE(4);
    const dir = [];
    for (let i = 0; i < numTables; i++) {
        const off = 12 + i * 16;
        dir.push({
            tag: buf.toString("latin1", off, off + 4),
            offset: buf.readUInt32BE(off + 8),
            length: buf.readUInt32BE(off + 12),
        });
    }

    const tables = {};
    for (const t of dir) {
        tables[t.tag] = Buffer.from(buf.subarray(t.offset, t.offset + t.length));
    }

    const { records, italic, isBold } = nameRecords(family, Number(weight), style);
    tables["name"] = buildNameTable(records);

    // OS/2 fsSelection + usWeightClass.
    const os2 = tables["OS/2"];
    if (os2 && os2.length >= 64) {
        os2.writeUInt16BE(Number(weight), 4); // usWeightClass
        let fs2 = os2.readUInt16BE(62);
        fs2 &= ~((1 << 0) | (1 << 5) | (1 << 6)); // clear italic/bold/regular
        if (italic) fs2 |= 1 << 0;
        if (isBold) fs2 |= 1 << 5;
        if (!italic && !isBold) fs2 |= 1 << 6;
        os2.writeUInt16BE(fs2, 62);
    }

    // head macStyle.
    const head = tables["head"];
    if (head && head.length >= 46) {
        let mac = head.readUInt16BE(44);
        mac &= ~((1 << 0) | (1 << 1)); // clear bold/italic
        if (isBold) mac |= 1 << 0;
        if (italic) mac |= 1 << 1;
        head.writeUInt16BE(mac, 44);
    }

    // Reassemble. Directory sorted by tag; data laid out 4-byte aligned.
    const tags = Object.keys(tables).sort();
    const headerLen = 12 + tags.length * 16;
    let dataLen = 0;
    for (const tag of tags) dataLen += pad4(tables[tag].length);

    const out = Buffer.alloc(headerLen + dataLen);
    buf.copy(out, 0, 0, 12); // keep sfnt version + numTables + search fields

    let cursor = headerLen;
    let headOffset = -1;
    tags.forEach((tag, i) => {
        const data = tables[tag];
        const dirOff = 12 + i * 16;
        out.write(tag.padEnd(4, " "), dirOff, "latin1");
        out.writeUInt32BE(checksum(data, 0, data.length), dirOff + 4);
        out.writeUInt32BE(cursor, dirOff + 8);
        out.writeUInt32BE(data.length, dirOff + 12);
        data.copy(out, cursor);
        if (tag === "head") headOffset = cursor;
        cursor += pad4(data.length);
    });

    // head.checkSumAdjustment: zero it, checksum whole file, then write.
    if (headOffset >= 0) {
        out.writeUInt32BE(0, headOffset + 8);
        const total = checksum(out, 0, out.length);
        out.writeUInt32BE((0xb1b0afba - total) >>> 0, headOffset + 8);
    }

    fs.writeFileSync(filepath, out);
}
