const SECTION_KEYWORDS = new Set([
  "PIE",
  "TYPE",
  "TEXTURE",
  "EVENT",
  "LEVELS",
  "LEVEL",
  "POINTS",
  "POLYGONS",
  "CONNECTORS",
  "ANIMOBJECT",
  "SHADOWPOINTS",
  "SHADOWPOLYGONS",
]);

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const normalized = Math.abs(value) < 1e-9 ? 0 : value;

  if (Number.isInteger(normalized)) {
    return String(normalized);
  }

  return normalized.toFixed(6).replace(/\.?0+$/, "");
}

function toNumericTriplet(line, label) {
  const values = line
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));

  if (values.length < 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid ${label} line: "${line}"`);
  }

  return { x: values[0], y: values[1], z: values[2] };
}

function parsePolygon(line) {
  const parts = line.trim().split(/\s+/).map((part) => Number(part));

  if (parts.length < 5 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid polygon line: "${line}"`);
  }

  const flags = parts[0];
  const vertexCount = parts[1];
  const indices = parts.slice(2, 2 + vertexCount);
  const uvValues = parts.slice(2 + vertexCount);

  if (indices.length !== vertexCount) {
    throw new Error(`Polygon is missing vertex indices: "${line}"`);
  }

  if (uvValues.length !== vertexCount * 2) {
    throw new Error(`Polygon UV count does not match vertex count: "${line}"`);
  }

  const uvs = [];

  for (let index = 0; index < uvValues.length; index += 2) {
    uvs.push({ u: uvValues[index], v: uvValues[index + 1] });
  }

  return {
    flags,
    vertexCount,
    indices,
    uvs,
  };
}

function isSectionLine(line) {
  const keyword = line.trim().split(/\s+/, 1)[0]?.toUpperCase();
  return SECTION_KEYWORDS.has(keyword);
}

export function parsePie(text, sourceName = "model.pie") {
  const lines = text.replace(/\r/g, "").split("\n");

  const model = {
    sourceName,
    version: 0,
    type: null,
    texture: null,
    events: [],
    levelsExpected: null,
    levels: [],
    topLevelExtras: [],
  };

  let pointer = 0;

  function skipBlankLines() {
    while (pointer < lines.length && !lines[pointer].trim()) {
      pointer += 1;
    }
  }

  function readBlock(count, label, parser) {
    const items = [];

    for (let blockIndex = 0; blockIndex < count; blockIndex += 1) {
      skipBlankLines();

      if (pointer >= lines.length) {
        throw new Error(`Unexpected end of file while reading ${label}`);
      }

      items.push(parser(lines[pointer]));
      pointer += 1;
    }

    return items;
  }

  function parseAnimObject(level) {
    const line = lines[pointer].trim();
    const headerTokens = line.split(/\s+/).slice(1);
    pointer += 1;

    const frames = [];

    while (pointer < lines.length) {
      const currentLine = lines[pointer];
      const trimmed = currentLine.trim();

      if (!trimmed) {
        pointer += 1;
        continue;
      }

      if (isSectionLine(trimmed)) {
        break;
      }

      const values = trimmed.split(/\s+/).map((part) => Number(part));

      if (!values.length || values.some((value) => !Number.isFinite(value))) {
        level.extraLines.push(trimmed);
      } else {
        frames.push(values);
      }

      pointer += 1;
    }

    level.animObject = {
      headerTokens,
      frames,
    };
  }

  function parseLevel() {
    const levelLine = lines[pointer].trim();
    const levelNumber = Number(levelLine.split(/\s+/)[1]);

    const level = {
      index: Number.isFinite(levelNumber) ? levelNumber : model.levels.length + 1,
      points: [],
      polygons: [],
      connectors: [],
      animObject: null,
      extraLines: [],
    };

    pointer += 1;

    while (pointer < lines.length) {
      skipBlankLines();

      if (pointer >= lines.length) {
        break;
      }

      const line = lines[pointer].trim();

      if (!line) {
        pointer += 1;
        continue;
      }

      if (line.startsWith("LEVEL ")) {
        break;
      }

      if (line.startsWith("POINTS ")) {
        const count = Number(line.split(/\s+/)[1]);
        pointer += 1;
        level.points = readBlock(count, "points", (value) => toNumericTriplet(value, "point"));
        continue;
      }

      if (line.startsWith("POLYGONS ")) {
        const count = Number(line.split(/\s+/)[1]);
        pointer += 1;
        level.polygons = readBlock(count, "polygons", parsePolygon);
        continue;
      }

      if (line.startsWith("CONNECTORS ")) {
        const count = Number(line.split(/\s+/)[1]);
        pointer += 1;
        level.connectors = readBlock(count, "connectors", (value) =>
          toNumericTriplet(value, "connector"),
        );
        continue;
      }

      if (line.startsWith("ANIMOBJECT ")) {
        parseAnimObject(level);
        continue;
      }

      if (
        line.startsWith("TYPE ") ||
        line.startsWith("TEXTURE ") ||
        line.startsWith("EVENT ") ||
        line.startsWith("LEVELS ")
      ) {
        break;
      }

      level.extraLines.push(line);
      pointer += 1;
    }

    return level;
  }

  while (pointer < lines.length) {
    skipBlankLines();

    if (pointer >= lines.length) {
      break;
    }

    const line = lines[pointer].trim();

    if (!line) {
      pointer += 1;
      continue;
    }

    if (line.startsWith("PIE ")) {
      model.version = Number(line.split(/\s+/)[1]);
      pointer += 1;
      continue;
    }

    if (line.startsWith("TYPE ")) {
      model.type = Number(line.split(/\s+/)[1]);
      pointer += 1;
      continue;
    }

    if (line.startsWith("TEXTURE ")) {
      const parts = line.split(/\s+/);
      model.texture = {
        index: Number(parts[1]),
        name: parts[2] ?? "",
        width: Number(parts[3] ?? 0),
        height: Number(parts[4] ?? 0),
      };
      pointer += 1;
      continue;
    }

    if (line.startsWith("EVENT ")) {
      const parts = line.split(/\s+/);
      model.events.push({
        index: Number(parts[1]),
        name: parts.slice(2).join(" "),
      });
      pointer += 1;
      continue;
    }

    if (line.startsWith("LEVELS ")) {
      model.levelsExpected = Number(line.split(/\s+/)[1]);
      pointer += 1;
      continue;
    }

    if (line.startsWith("LEVEL ")) {
      model.levels.push(parseLevel());
      continue;
    }

    model.topLevelExtras.push(line);
    pointer += 1;
  }

  if (!model.levels.length) {
    throw new Error("No LEVEL sections were found in the PIE file.");
  }

  return model;
}

export function serializePie(model) {
  const lines = [];

  lines.push(`PIE ${formatNumber(model.version || 3)}`);

  if (model.type !== null) {
    lines.push(`TYPE ${formatNumber(model.type)}`);
  }

  if (model.texture) {
    lines.push(
      `TEXTURE ${formatNumber(model.texture.index)} ${model.texture.name} ${formatNumber(model.texture.width)} ${formatNumber(model.texture.height)}`,
    );
  }

  for (const event of model.events ?? []) {
    lines.push(`EVENT ${formatNumber(event.index)} ${event.name}`);
  }

  lines.push(`LEVELS ${formatNumber(model.levels.length)}`);

  for (const level of model.levels) {
    lines.push(`LEVEL ${formatNumber(level.index)}`);
    lines.push(`POINTS ${formatNumber(level.points.length)}`);

    for (const point of level.points) {
      lines.push(`\t${formatNumber(point.x)} ${formatNumber(point.y)} ${formatNumber(point.z)}`);
    }

    lines.push(`POLYGONS ${formatNumber(level.polygons.length)}`);

    for (const polygon of level.polygons) {
      const tokens = [
        formatNumber(polygon.flags),
        formatNumber(polygon.vertexCount),
        ...polygon.indices.map((value) => formatNumber(value)),
        ...polygon.uvs.flatMap((uv) => [formatNumber(uv.u), formatNumber(uv.v)]),
      ];

      lines.push(`\t${tokens.join(" ")}`);
    }

    if (level.connectors?.length) {
      lines.push(`CONNECTORS ${formatNumber(level.connectors.length)}`);

      for (const connector of level.connectors) {
        lines.push(
          `\t${formatNumber(connector.x)} ${formatNumber(connector.y)} ${formatNumber(connector.z)}`,
        );
      }
    }

    if (level.animObject) {
      lines.push(`ANIMOBJECT ${level.animObject.headerTokens.join(" ")}`.trimEnd());

      for (const frame of level.animObject.frames) {
        lines.push(`\t\t${frame.map((value) => formatNumber(value)).join("\t")}`);
      }
    }

    for (const extraLine of level.extraLines ?? []) {
      lines.push(extraLine);
    }
  }

  for (const extraLine of model.topLevelExtras ?? []) {
    lines.push(extraLine);
  }

  return `${lines.join("\n")}\n`;
}

export function getUvMode(model) {
  if (!model.texture) {
    return "No texture info";
  }

  if (model.version >= 3 || model.texture.width === 0 || model.texture.height === 0) {
    return "Normalized UVs";
  }

  return `${formatNumber(model.texture.width)}x${formatNumber(model.texture.height)} texture page`;
}

export function summarizeLevel(level) {
  return {
    points: level.points.length,
    polygons: level.polygons.length,
    connectors: level.connectors?.length ?? 0,
    frames: level.animObject?.frames.length ?? 0,
  };
}
