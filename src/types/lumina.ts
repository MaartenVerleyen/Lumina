export interface FaceInstance {
  face_id: string;
  hash: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  person_name?: string | null;
  face_thumb: string;
  confidence: number;
}

export interface FaceMatchEvent {
  person_name: string;
  matched_hashes: string[];
  total_matched: number;
}

export interface FaceScanProgress {
  completed: number;
  total: number;
  faces_found: number;
  auto_matched: number;
  batch_faces?: Record<string, FaceInstance[]>;
  batch_people?: Record<string, string[]>;
  done: boolean;
  cancelled: boolean;
}

export interface ScanProgressEvent {
  stage: string;
  current_file: string;
  completed: number;
  total: number;
  percent: number;
  done: boolean;
}

export interface PhotoItem {
  hash: string;
  name: string;
  subfolder: string;
  path: string;
  thumb_path: string;
  size_kb: number;
  width: number;
  height: number;
  thumb_ready: boolean;
  rating: number;
  flag: "pick" | "reject" | null;
  color_label: "red" | "yellow" | "green" | "blue" | null;
  rotation: number;
  in_basket: boolean;
  tags: string[];
  people: string[];
  faces: FaceInstance[];
  ai_caption: string;
  ocr_text: string;
  captured_at: string;
  camera_model: string;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  dhash: string;
  sharpness: number;
  duplicate_group?: number | null;
  staged_target?: string | null;
  // Phase 6 Pro Telemetry & RAW Pair Linking
  focal_length?: string | null;
  aperture?: string | null;
  shutter_speed?: string | null;
  iso?: string | null;
  lens_model?: string | null;
  pair_raw_path?: string | null;
  // File is truncated/corrupt: its thumbnail was recovered from partial data (or could not be made)
  damaged: boolean;
  // Bumped when the thumbnail file was replaced (cache-busts the grid image)
  thumb_rev?: number;
}

export interface PersonItem {
  id: number;
  name: string;
  photo_count: number;
  cover_thumb: string;
  // Hidden people stay on their photos but leave the people bar and get no suggestions
  hidden: boolean;
}

export interface ThumbBatchItem {
  hash: string;
  thumb_path: string;
  dhash: string;
  sharpness: number;
  width: number;
  height: number;
  auto_tags: string[];
  thumb_ok: boolean;
  damaged: boolean;
  // Long edge the thumbnail file was (re)written at; 0 when the existing file was reused
  thumb_edge: number;
}

export interface ThumbBatchProgress {
  items: ThumbBatchItem[];
  duplicate_groups: Record<string, number>;
  completed: number;
  total: number;
  folder: string;
}

export interface ExifRefreshResult {
  hash: string;
  captured_at: string;
  camera_model: string;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  focal_length?: string | null;
  aperture?: string | null;
  shutter_speed?: string | null;
  iso?: string | null;
  lens_model?: string | null;
}

export interface TimelineBucket {
  period: string;
  count: number;
}

export interface CitySearchResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface TimestampShiftResult {
  hash: string;
  captured_at: string;
}

export interface LibraryHealthStats {
  total_photos: number;
  total_library_size_mb: number;
  trash_staged_count: number;
  trash_recoverable_mb: number;
  duplicate_extras_count: number;
  duplicate_recoverable_mb: number;
  cache_files_count: number;
  cache_size_mb: number;
  orphaned_cache_count: number;
  camera_breakdown: [string, number][];
  damaged_count: number;
  damaged_files: string[];
}

export type AutoStagePreset =
  | "YEAR_MONTH_CITY"
  | "YEAR_MONTH"
  | "PERSON_YEAR"
  | "SCREENSHOTS_BY_MONTH"
  | "FAVORITES_YEAR";

export interface AiAnalysisResult {
  tags: string[];
  people: string[];
  faces: FaceInstance[];
  caption: string;
  ocr_text: string;
  perf: AiPerf;
}

export interface AiPerf {
  image_kb: number;
  encode_ms: number;
  request_ms: number;
  post_ms: number;
  total_ms: number;
  ollama_load_ms: number;
  prompt_tokens: number;
  prompt_eval_ms: number;
  output_tokens: number;
  output_eval_ms: number;
}

export interface FileOpFailure {
  file: string;
  error: string;
}

export interface CommitResult {
  moved: number;
  failures: FileOpFailure[];
}

export interface TrashResult {
  recycled: number;
  failures: FileOpFailure[];
}

// One-time download of the face recognition models (InsightFace buffalo_l, 288 MB)
// A group of unnamed faces that look like the same person ("Who is this?")
export interface FaceCluster {
  size: number;
  face_ids: string[];
  samples: SimilarFaceCandidate[];
}

export interface FaceModelDownloadProgress {
  downloaded_mb: number;
  total_mb: number;
  percent: number;
  stage: string;
  done: boolean;
}

export interface XmpExportResult {
  exported: number;
  skipped_foreign: number;
  skipped_raw_pair: number;
  failed: number;
}

export interface PerfLogEvent {
  label: string;
  millis: number;
  count: number;
  details: string;
}

export interface AiFailureItem {
  photo: PhotoItem;
  error: string;
  attempts: number;
}

export interface AiBatchReport {
  succeededCount: number;
  failures: AiFailureItem[];
}

export interface OllamaStatus {
  running: boolean;
  active_vram_model: string | null;
  installed_models: { name: string; size_gb: number }[];
}

export type SmartFilter =
  | "ALL"
  | "PICKS"
  | "REJECTS"
  | "BASKET"
  | "FAVORITES"
  | "UNTAGGED"
  | "AI_TAGGED"
  | "SCREENSHOTS"
  | "DUPLICATES"
  | "HAS_OCR"
  | "HAS_GPS"
  | "STAGED";

export type OrientationFilter = "ALL" | "LANDSCAPE" | "PORTRAIT" | "SQUARE";

export type SortOption =
  | "NAME_ASC"
  | "NAME_DESC"
  | "DATE_DESC"
  | "DATE_ASC"
  | "SCORE_DESC"
  | "SCORE_ASC"
  | "RATING_DESC"
  | "TAG_NAME"
  | "TAG_COUNT"
  | "SIZE_DESC";

export interface FolderTreeNode {
  name: string;
  fullPath: string;
  directCount: number;
  totalCount: number;
  children: FolderTreeNode[];
}

export interface OllamaPullProgress {
  model: string;
  status: string;
  completed_mb: number;
  total_mb: number;
  percent: number;
  done: boolean;
}

export interface PhotoActionSnapshot {
  hash: string;
  flag: "pick" | "reject" | null;
  rating: number;
  color_label: "red" | "yellow" | "green" | "blue" | null;
  staged_target: string | null;
  in_basket: boolean;
  rotation: number;
}

export interface UndoHistoryEntry {
  description: string;
  previousActiveHash: string | null;
  previousSelectedHashes: string[];
  before: PhotoActionSnapshot[];
  after: PhotoActionSnapshot[];
  // Changes the snapshots can't express (tags, location, capture time, people) bring their own undo/redo
  undoAction?: () => Promise<void>;
  redoAction?: () => Promise<void>;
}

export interface SessionLogEntry {
  id: string;
  timestamp: string;
  category: "LIBRARY" | "TRIAGE" | "FACE" | "AI" | "DISK" | "PERF" | "ERROR";
  message: string;
  details?: string;
}

export interface SimilarFaceCandidate {
  face_id: string;
  hash: string;
  face_thumb: string;
  photo_name: string;
  photo_path: string;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  current_person?: string | null;
  similarity: number;
}

// Smart search (CLIP)
export interface SemanticStatus {
  models_ready: boolean;
  indexed: number;
  total: number;
  running: boolean;
}

export interface SemanticProgress {
  stage: "download" | "index";
  completed: number;
  total: number;
  message: string;
  done: boolean;
  cancelled: boolean;
}

export interface SemanticHit {
  hash: string;
  score: number;
}

// Albums (hand-picked) and smart albums (saved searches)
export interface Album {
  id: number;
  name: string;
  hashes: string[];
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
}

export type BulkPopover = "tag" | "person" | "move" | "location" | "time" | "album";

export interface ExportProgress {
  completed: number;
  total: number;
  done: boolean;
  cancelled: boolean;
}

export interface ExportResult {
  exported: number;
  failures: FileOpFailure[];
  cancelled: boolean;
}

// Top-level tabs: Photos ("grid", or "compare" inside Photos) · Map · People · Collections
export type ViewMode = "grid" | "map" | "compare" | "people" | "collections";
