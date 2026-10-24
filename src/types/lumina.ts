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
}

export interface PersonItem {
  id: number;
  name: string;
  photo_count: number;
  cover_thumb: string;
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
}

export interface ThumbBatchProgress {
  items: ThumbBatchItem[];
  duplicate_groups: Record<string, number>;
  completed: number;
  total: number;
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
}

export interface SessionLogEntry {
  id: string;
  timestamp: string;
  category: "LIBRARY" | "TRIAGE" | "FACE" | "AI" | "DISK";
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