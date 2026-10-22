<div align="center">
  <img src="../src/assets/lumina-mark.svg" width="64" alt="Lumina Logo" />
  <h1>Lumina v3.0</h1>
  <p><strong>High-Performance Local Photo Triage & AI Culling Desktop Studio</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Tauri-v2-blue?style=flat-square" alt="Tauri v2" />
    <img src="https://img.shields.io/badge/React-18+-cyan?style=flat-square" alt="React" />
    <img src="https://img.shields.io/badge/Rust-Backend-orange?style=flat-square" alt="Rust" />
    <img src="https://img.shields.io/badge/SQLite-Local_WAL-green?style=flat-square" alt="SQLite" />
    <img src="https://img.shields.io/badge/AI-Ollama_%2F_Qwen3--VL-purple?style=flat-square" alt="Ollama AI" />
  </p>
</div>

---

**Lumina** is a lightning-fast, privacy-first desktop photo triage and culling studio designed for photographers managing massive local archives ($6,000+$ photos). Built with native Rust performance, SQLite caching, local Ollama Vision AI, and an ONNX neural face recognition pipeline, Lumina provides a frictionless Lightroom-style darkroom experience entirely on your local machine.

---

## ✨ Key Features

### 🚀 Professional-Grade Triage & Culling
* **Lightning-Fast Virtualized Grid:** Seamlessly render and scroll tens of thousands of raw/JPEG photos with zero frame drops using TanStack Virtual.
* **Pro Culling Flags & Auto-Advance:** Instant Pick (`P`), Reject (`X`), and Unflag (`U`) shortcuts with an **Auto-Advance** toggle that jumps to the next photo automatically.
* **Color Labels (`6`–`9`):** Quick color coding (Red, Yellow, Green, Blue) with corner ribbons.
* **Non-Destructive Rotation (`[` and `]`):** Lossless rotation persistence stored directly in SQLite without altering raw physical files.
* **Side-by-Side Synchronized Compare Mode (`C`):** Multi-pane comparison (2–4 photos) with synchronized zoom (up to 600%) and pan across identical pixel coordinates to inspect sharpness.

### 🧠 Local AI Vision & OCR ($Qwen3-VL$)
* **Instant JSON Vision Parsing:** Integrates with local Ollama (`qwen3-vl:8b`) using assistant prefilling to bypass thinking tokens for instantaneous object tagging, scene setting, and captions.
* **Text & Document Recognition (OCR):** Automatically extracts and indexes text from signs, labels, documents, and screenshots.
* **Screenshot & Burst Clustering:** Native Rust 64-bit gradient hashing ($dHash$) automatically clusters bursts and screenshots in $< 2\text{ ms}$.

### 👤 ONNX Neural Face Recognition ($UltraFace$)
* **Pure-Rust ONNX Runtime (`tract-onnx`):** Zero external DLL dependencies on Windows. Automatically provisions the lightweight UltraFace neural detector in the background (~8ms per image).
* **Biometric Auto-Matching:** Computes 384-D illumination-invariant facial descriptors. Name a face once, and Lumina automatically matches and tags them across your entire library.

### 📅 Interactive Timeline Slicer & Map
* **Excel/Lightroom-Style Timeline Slicer:** Slide-out drawer with a daily histogram frequency chart. Click and drag across days or scrub handles to filter time ranges instantly.
* **Offline Map Geotagging:** Interactive Leaflet map supporting offline city search and 1-click map GPS pinning.

---

## 🛠️ Tech Stack

* **Frontend:** React, TypeScript, Tailwind CSS v4, Lucide Icons, TanStack Virtual, Leaflet.
* **Backend:** Rust, Tauri v2, `rusqlite` (WAL mode), `rayon` (multi-threaded parallel pipelines), `tract-onnx`.
* **AI & Vision:** Ollama (`qwen3-vl:8b`), `kamadak-exif`, `image`.

---

## ⚙️ Installation & Development

### Prerequisites
1. **Node.js** (v18+) and **npm**.
2. **Rust Toolchain** (install via [rustup.rs](https://rustup.rs/)).
3. **Ollama** installed locally with `qwen3-vl:8b` pulled:
   ```bash
   ollama pull qwen3-vl:8b
   ```

### Running Locally
```bash
# Clone the repository
git clone https://github.com/your-username/lumina.git
cd lumina

# Install frontend dependencies
npm install

# Run the Tauri development server
npm run tauri dev
```

---

## ⌨️ Pro Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| **`Space`** | Open / Close Fullscreen Loupe HUD |
| **`Arrow Keys`** | Navigate grid or flip through fullscreen photos (`Shift + Arrow` to multi-select) |
| **`P`** | Set Pick Flag (`🚩`) & Auto-Advance |
| **`X`** | Set Reject Flag (`❌`), Stage for `_Trash`, & Auto-Advance |
| **`U`** | Clear Flag |
| **`1` – `5`** | Set Star Rating & Auto-Advance |
| **`0`** | Clear Star Rating |
| **`6` – `9`** | Color Labels (Red, Yellow, Green, Blue) |
| **`[` / `]`** | Rotate 90° Counter-Clockwise / Clockwise |
| **`C`** | Toggle Synchronized Side-by-Side Compare Mode |
| **`B`** | Toggle Pinboard Basket Selection |
| **`A`** | Run AI Vision Analysis on Active Photo |
| **`Ctrl + K`** | Focus Global Search Bar |