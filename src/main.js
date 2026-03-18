import "./styles.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getUvMode, parsePie, serializePie, summarizeLevel } from "./pie-format.js";

const elements = {
  exportButton: document.querySelector("#export-button"),
  fileInput: document.querySelector("#file-input"),
  fitButton: document.querySelector("#fit-button"),
  levelSelect: document.querySelector("#level-select"),
  modelChip: document.querySelector("#model-chip"),
  modelSummary: document.querySelector("#model-summary"),
  notesList: document.querySelector("#notes-list"),
  pointEditor: document.querySelector("#point-editor"),
  pointEmpty: document.querySelector("#point-empty"),
  pointList: document.querySelector("#point-list"),
  pointX: document.querySelector("#point-x"),
  pointY: document.querySelector("#point-y"),
  pointZ: document.querySelector("#point-z"),
  sampleButton: document.querySelector("#sample-button"),
  selectedPointIndex: document.querySelector("#selected-point-index"),
  statusText: document.querySelector("#status-text"),
  textureChip: document.querySelector("#texture-chip"),
  toggleAxes: document.querySelector("#toggle-axes"),
  toggleConnectors: document.querySelector("#toggle-connectors"),
  toggleGrid: document.querySelector("#toggle-grid"),
  toggleInvertV: document.querySelector("#toggle-invert-v"),
  togglePoints: document.querySelector("#toggle-points"),
  toggleWireframe: document.querySelector("#toggle-wireframe"),
  uvBadge: document.querySelector("#uv-badge"),
  viewer: document.querySelector("#viewer"),
  connectorList: document.querySelector("#connector-list"),
};

const SAMPLE_PIE_URL = `${import.meta.env.BASE_URL}samples/trlcan.pie`;

const state = {
  activeLevelIndex: 0,
  model: null,
  selectedPointIndex: null,
  loadedTextures: new Map(),
  textureUrls: new Map(),
  view: {
    axes: true,
    connectors: true,
    grid: true,
    invertV: false,
    points: true,
    wireframe: true,
  },
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4000);
camera.position.set(42, 32, 48);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(elements.viewer.clientWidth, elements.viewer.clientHeight);
elements.viewer.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 8, 0);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const modelGroup = new THREE.Group();
scene.add(modelGroup);

const gridHelper = new THREE.GridHelper(160, 16, 0x274046, 0x1b2f34);
scene.add(gridHelper);

const axesHelper = new THREE.AxesHelper(18);
scene.add(axesHelper);

scene.add(new THREE.AmbientLight(0xffffff, 0.8));

const keyLight = new THREE.DirectionalLight(0xffd0a3, 1.45);
keyLight.position.set(28, 40, 32);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x7dcfc6, 0.6);
fillLight.position.set(-24, 20, -22);
scene.add(fillLight);

const sceneObjects = {
  connectors: null,
  pointCloud: null,
  selectedPoint: null,
  wireframe: null,
};

const resizeObserver = new ResizeObserver(() => {
  const width = elements.viewer.clientWidth || 1;
  const height = elements.viewer.clientHeight || 1;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
});

resizeObserver.observe(elements.viewer);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function getActiveLevel() {
  return state.model?.levels?.[state.activeLevelIndex] ?? null;
}

function formatCoordinate(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const normalized = Math.abs(value) < 1e-9 ? 0 : value;

  if (Number.isInteger(normalized)) {
    return String(normalized);
  }

  return normalized.toFixed(4).replace(/\.?0+$/, "");
}

function normalizeTextureKey(value) {
  return value.replaceAll("\\", "/").split("/").pop().toLowerCase();
}

async function loadTextureForCurrentModel() {
  const textureName = state.model?.texture?.name;

  if (!textureName) {
    return null;
  }

  const key = normalizeTextureKey(textureName);
  const textureUrl = state.textureUrls.get(key);

  if (!textureUrl) {
    return null;
  }

  const cachedTexture = state.loadedTextures.get(key);

  if (cachedTexture) {
    return cachedTexture;
  }

  const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  state.loadedTextures.set(key, texture);
  return texture;
}

function uvToThree(uv) {
  if (!state.model?.texture) {
    return [uv.u, uv.v];
  }

  const { width, height } = state.model.texture;
  const useNormalized = state.model.version >= 3 || width === 0 || height === 0;
  const u = useNormalized ? uv.u : uv.u / width;
  const v = useNormalized ? uv.v : uv.v / height;

  return [u, state.view.invertV ? 1 - v : v];
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children[group.children.length - 1];
    group.remove(child);

    child.traverse?.((node) => {
      node.geometry?.dispose?.();

      if (Array.isArray(node.material)) {
        node.material.forEach((material) => material.dispose?.());
      } else {
        node.material?.dispose?.();
      }
    });
  }
}

function buildLevelGeometry(level) {
  const positions = [];
  const uvs = [];

  for (const polygon of level.polygons) {
    if (polygon.vertexCount !== 3) {
      continue;
    }

    polygon.indices.forEach((pointIndex, vertexIndex) => {
      const point = level.points[pointIndex];

      if (!point) {
        return;
      }

      positions.push(point.x, point.y, point.z);
      const uv = polygon.uvs[vertexIndex] ?? { u: 0, v: 0 };
      const [u, v] = uvToThree(uv);
      uvs.push(u, v);
    });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildPointGeometry(level) {
  const positions = level.points.flatMap((point) => [point.x, point.y, point.z]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildConnectorGeometry(level) {
  const positions = level.connectors.flatMap((point) => [point.x, point.y, point.z]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function computeModelScale(level) {
  if (!level.points.length) {
    return 20;
  }

  const box = new THREE.Box3().setFromPoints(
    level.points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
  );

  return Math.max(box.getSize(new THREE.Vector3()).length(), 8);
}

function fitCameraToCurrentLevel() {
  const level = getActiveLevel();

  if (!level) {
    return;
  }

  const box = new THREE.Box3().setFromPoints(
    level.points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
  );

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 10);
  const distance = maxSize * 1.8;

  camera.position.set(center.x + distance, center.y + distance * 0.7, center.z + distance);
  controls.target.copy(center);
  controls.update();
}

function updateSelectedPointMarker(level, scale) {
  if (sceneObjects.selectedPoint) {
    modelGroup.remove(sceneObjects.selectedPoint);
    sceneObjects.selectedPoint.geometry.dispose();
    sceneObjects.selectedPoint.material.dispose();
    sceneObjects.selectedPoint = null;
  }

  if (state.selectedPointIndex === null) {
    return;
  }

  const point = level.points[state.selectedPointIndex];

  if (!point) {
    return;
  }

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(scale * 0.02, 0.45), 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xff9656 }),
  );

  marker.position.set(point.x, point.y, point.z);
  sceneObjects.selectedPoint = marker;
  modelGroup.add(marker);
}

function updateOverlayVisibility() {
  gridHelper.visible = state.view.grid;
  axesHelper.visible = state.view.axes;

  if (sceneObjects.wireframe) {
    sceneObjects.wireframe.visible = state.view.wireframe;
  }

  if (sceneObjects.pointCloud) {
    sceneObjects.pointCloud.visible = state.view.points;
  }

  if (sceneObjects.connectors) {
    sceneObjects.connectors.visible = state.view.connectors;
  }
}

async function rebuildScene({ fitCamera = false } = {}) {
  const level = getActiveLevel();

  clearGroup(modelGroup);
  sceneObjects.connectors = null;
  sceneObjects.pointCloud = null;
  sceneObjects.selectedPoint = null;
  sceneObjects.wireframe = null;

  if (!level) {
    renderer.render(scene, camera);
    return;
  }

  const geometry = buildLevelGeometry(level);
  const scale = computeModelScale(level);
  const texture = await loadTextureForCurrentModel();

  const material = new THREE.MeshStandardMaterial({
    color: texture ? 0xffffff : 0x90a8ad,
    map: texture,
    flatShading: true,
    metalness: 0.1,
    roughness: 0.72,
    side: THREE.DoubleSide,
  });

  modelGroup.add(new THREE.Mesh(geometry, material));

  const wireframe = new THREE.LineSegments(
    new THREE.WireframeGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xff9656, opacity: 0.72, transparent: true }),
  );
  sceneObjects.wireframe = wireframe;
  modelGroup.add(wireframe);

  const pointCloud = new THREE.Points(
    buildPointGeometry(level),
    new THREE.PointsMaterial({
      color: 0xffd2b2,
      size: Math.max(scale * 0.03, 0.8),
      sizeAttenuation: true,
    }),
  );
  sceneObjects.pointCloud = pointCloud;
  modelGroup.add(pointCloud);

  if (level.connectors.length) {
    const connectors = new THREE.Points(
      buildConnectorGeometry(level),
      new THREE.PointsMaterial({
        color: 0x7dcfc6,
        size: Math.max(scale * 0.035, 0.85),
        sizeAttenuation: true,
      }),
    );

    sceneObjects.connectors = connectors;
    modelGroup.add(connectors);
  }

  raycaster.params.Points.threshold = Math.max(scale * 0.05, 1.2);
  updateSelectedPointMarker(level, scale);
  updateOverlayVisibility();

  if (fitCamera) {
    fitCameraToCurrentLevel();
  }

  const expectedTexture = state.model.texture?.name;
  elements.textureChip.textContent = texture
    ? `Texture: ${expectedTexture}`
    : expectedTexture
      ? `Texture missing: ${expectedTexture}`
      : "Texture not defined";
}

function renderSummary() {
  const level = getActiveLevel();

  if (!state.model || !level) {
    elements.modelSummary.innerHTML =
      '<article class="stat-card"><span>Status</span><strong>Awaiting PIE file</strong></article>';
    return;
  }

  const levelStats = summarizeLevel(level);
  const summaryItems = [
    ["File", state.model.sourceName],
    ["PIE", state.model.version],
    ["Type", state.model.type ?? "N/A"],
    ["Levels", state.model.levels.length],
    ["Points", levelStats.points],
    ["Polygons", levelStats.polygons],
    ["Connectors", levelStats.connectors],
    ["Frames", levelStats.frames],
  ];

  elements.modelSummary.innerHTML = summaryItems
    .map(
      ([label, value]) =>
        `<article class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`,
    )
    .join("");
}

function renderNotes() {
  if (!state.model) {
    elements.notesList.innerHTML = '<div class="empty-state">Model notes will appear here.</div>';
    return;
  }

  const level = getActiveLevel();
  const notes = [{ title: "UV Mode", detail: getUvMode(state.model) }];

  if (state.model.texture?.name) {
    notes.push({ title: "Texture Page", detail: state.model.texture.name });
  }

  if (state.model.events.length) {
    notes.push({
      title: "Events",
      detail: state.model.events.map((event) => `${event.index}: ${event.name}`).join(" | "),
    });
  }

  if (level?.animObject) {
    notes.push({
      title: "AnimObject",
      detail: `${level.animObject.headerTokens.join(" ")} | ${level.animObject.frames.length} frames`,
    });
  }

  elements.notesList.innerHTML = notes
    .map(
      (note) =>
        `<div class="note-item"><strong>${escapeHtml(note.title)}</strong><span>${escapeHtml(note.detail)}</span></div>`,
    )
    .join("");
}

function renderLevelOptions() {
  if (!state.model) {
    elements.levelSelect.innerHTML = "";
    elements.levelSelect.disabled = true;
    return;
  }

  elements.levelSelect.innerHTML = state.model.levels
    .map(
      (level, index) =>
        `<option value="${index}" ${index === state.activeLevelIndex ? "selected" : ""}>Level ${level.index}</option>`,
    )
    .join("");

  elements.levelSelect.disabled = false;
}

function renderPointEditor() {
  const level = getActiveLevel();
  const point =
    level && state.selectedPointIndex !== null ? level.points[state.selectedPointIndex] : null;

  if (!point) {
    elements.pointEditor.hidden = true;
    elements.pointEmpty.hidden = false;
    return;
  }

  elements.pointEditor.hidden = false;
  elements.pointEmpty.hidden = true;
  elements.selectedPointIndex.textContent = String(state.selectedPointIndex);
  elements.pointX.value = String(point.x);
  elements.pointY.value = String(point.y);
  elements.pointZ.value = String(point.z);
}

function renderPointList() {
  const level = getActiveLevel();

  if (!level) {
    elements.pointList.innerHTML = '<div class="empty-state">No point data loaded.</div>';
    return;
  }

  elements.pointList.innerHTML = level.points.length
    ? level.points
        .map(
          (point, index) =>
            `<button class="list-item ${state.selectedPointIndex === index ? "active" : ""}" type="button" data-point-index="${index}"><strong>Point ${index}</strong><span>${escapeHtml(`X ${formatCoordinate(point.x)} | Y ${formatCoordinate(point.y)} | Z ${formatCoordinate(point.z)}`)}</span></button>`,
        )
        .join("")
    : '<div class="empty-state">This level has no points.</div>';
}

function renderConnectorList() {
  const level = getActiveLevel();

  if (!level) {
    elements.connectorList.innerHTML = '<div class="empty-state">No connector data loaded.</div>';
    return;
  }

  elements.connectorList.innerHTML = level.connectors.length
    ? level.connectors
        .map(
          (connector, index) =>
            `<div class="note-item"><strong>Connector ${index}</strong><span>${escapeHtml(`X ${formatCoordinate(connector.x)} | Y ${formatCoordinate(connector.y)} | Z ${formatCoordinate(connector.z)}`)}</span></div>`,
        )
        .join("")
    : '<div class="empty-state">This level does not define any connectors.</div>';
}

function renderChrome() {
  const level = getActiveLevel();

  elements.exportButton.disabled = !state.model;
  elements.modelChip.textContent = state.model
    ? `${state.model.sourceName} | Level ${level?.index ?? "-"}`
    : "No model loaded";
  elements.uvBadge.textContent = state.model ? getUvMode(state.model) : "No file";

  renderLevelOptions();
  renderSummary();
  renderNotes();
  renderPointEditor();
  renderPointList();
  renderConnectorList();
}

async function renderAll({ fitCamera = false } = {}) {
  renderChrome();
  await rebuildScene({ fitCamera });
}

function selectPoint(index) {
  const level = getActiveLevel();

  if (!level || !level.points[index]) {
    return;
  }

  state.selectedPointIndex = index;
  renderChrome();
  rebuildScene();
}

function updateSelectedPoint(axis, rawValue) {
  const level = getActiveLevel();

  if (!level || state.selectedPointIndex === null) {
    return;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    return;
  }

  level.points[state.selectedPointIndex][axis] = value;
  renderChrome();
  rebuildScene();
}

async function loadPieFromText(text, sourceName) {
  state.model = parsePie(text, sourceName);
  state.activeLevelIndex = 0;
  state.selectedPointIndex = null;
  await renderAll({ fitCamera: true });
  setStatus(`Loaded ${sourceName}. Drop a matching texture page to see textured faces.`);
}

function registerTexture(file) {
  const key = normalizeTextureKey(file.name);
  const previousUrl = state.textureUrls.get(key);
  const previousTexture = state.loadedTextures.get(key);

  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }

  if (previousTexture) {
    previousTexture.dispose();
    state.loadedTextures.delete(key);
  }

  state.textureUrls.set(key, URL.createObjectURL(file));
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  const pieFile = files.find((file) => file.name.toLowerCase().endsWith(".pie"));
  const textureFiles = files.filter((file) => /\.(png|jpe?g|webp|bmp)$/i.test(file.name));

  textureFiles.forEach(registerTexture);

  if (pieFile) {
    await loadPieFromText(await pieFile.text(), pieFile.name);
    return;
  }

  if (textureFiles.length && state.model) {
    await renderAll();
    setStatus(`Registered ${textureFiles.length} texture file(s).`);
  }
}

function exportCurrentPie() {
  if (!state.model) {
    return;
  }

  const blob = new Blob([serializePie(state.model)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = state.model.sourceName.replace(/\.pie$/i, "");

  link.href = url;
  link.download = `${baseName}-edited.pie`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${baseName}-edited.pie.`);
}

function pickPointFromPointer(event) {
  if (!sceneObjects.pointCloud) {
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(sceneObjects.pointCloud);

  if (hits.length) {
    selectPoint(hits[0].index);
  }
}

function bindEvents() {
  elements.fileInput.addEventListener("change", async (event) => {
    if (event.target.files?.length) {
      await handleFiles(event.target.files);
      event.target.value = "";
    }
  });

  elements.sampleButton.addEventListener("click", async () => {
    const response = await fetch(SAMPLE_PIE_URL);
    await loadPieFromText(await response.text(), "trlcan.pie");
  });

  elements.exportButton.addEventListener("click", exportCurrentPie);
  elements.fitButton.addEventListener("click", fitCameraToCurrentLevel);

  elements.levelSelect.addEventListener("change", async (event) => {
    state.activeLevelIndex = Number(event.target.value);
    state.selectedPointIndex = null;
    await renderAll({ fitCamera: true });
    setStatus(`Viewing level ${getActiveLevel()?.index ?? "-"}.`);
  });

  elements.toggleWireframe.addEventListener("change", (event) => {
    state.view.wireframe = event.target.checked;
    updateOverlayVisibility();
  });

  elements.togglePoints.addEventListener("change", (event) => {
    state.view.points = event.target.checked;
    updateOverlayVisibility();
  });

  elements.toggleConnectors.addEventListener("change", (event) => {
    state.view.connectors = event.target.checked;
    updateOverlayVisibility();
  });

  elements.toggleGrid.addEventListener("change", (event) => {
    state.view.grid = event.target.checked;
    updateOverlayVisibility();
  });

  elements.toggleAxes.addEventListener("change", (event) => {
    state.view.axes = event.target.checked;
    updateOverlayVisibility();
  });

  elements.toggleInvertV.addEventListener("change", async (event) => {
    state.view.invertV = event.target.checked;
    await rebuildScene();
    setStatus("Updated texture V orientation.");
  });

  elements.pointX.addEventListener("input", (event) => updateSelectedPoint("x", event.target.value));
  elements.pointY.addEventListener("input", (event) => updateSelectedPoint("y", event.target.value));
  elements.pointZ.addEventListener("input", (event) => updateSelectedPoint("z", event.target.value));

  elements.pointList.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-point-index]");

    if (trigger) {
      selectPoint(Number(trigger.dataset.pointIndex));
    }
  });

  let pointerDown = null;

  renderer.domElement.addEventListener("pointerdown", (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
  });

  renderer.domElement.addEventListener("pointerup", (event) => {
    if (!pointerDown) {
      return;
    }

    const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    pointerDown = null;

    if (distance < 4) {
      pickPointFromPointer(event);
    }
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("drop", async (event) => {
    event.preventDefault();

    if (event.dataTransfer?.files?.length) {
      await handleFiles(event.dataTransfer.files);
    }
  });
}

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

bindEvents();
animate();
renderChrome();

fetch(SAMPLE_PIE_URL)
  .then((response) => response.text())
  .then((text) => loadPieFromText(text, "trlcan.pie"))
  .catch(() => {
    setStatus("Ready. Drop a PIE file to begin.");
  });
