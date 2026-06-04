/**
 * Shared types for the Reverse Engineering Workbench integration.
 * These replace the @workspace/api-client-react type imports from the original workbench.
 */

export interface HealthStatus {
  status: string;
}

export interface Binary {
  id: string;
  filename: string;
  fileHash: string;
  fileSize: number;
  fileType?: string | null;
  detectedModule?: string | null;
  uploadedAt: string;
  sharedWithMe?: boolean;
  ownerEmail?: string | null;
}

export interface UploadResult {
  binary: Binary;
  analysisId: string;
}

export type AnalysisStatus = "pending" | "running" | "complete" | "failed";

export type AnalysisFindings = Record<string, unknown> | null;
export type AnalysisToolCallTraceItem = Record<string, unknown>;

export interface AnalysisSpecialistNotes {
  crypto?: string;
  protocol?: string;
  firmware?: string;
  vuln?: string;
}

export interface Analysis {
  id: string;
  binaryId: string;
  filename: string;
  fileSize: number;
  fileType?: string | null;
  detectedModule?: string | null;
  status: AnalysisStatus;
  summary?: string | null;
  errorMessage?: string | null;
  algorithmCount: number;
  seedKeyCount: number;
  canAddressCount: number;
  checksumCount: number;
  securityByteCount: number;
  stringCount: number;
  entropy?: number | null;
  confidence?: number | null;
  createdAt: string;
  completedAt?: string | null;
  findings: AnalysisFindings;
  toolCallTrace: AnalysisToolCallTraceItem[];
  specialistNotes?: AnalysisSpecialistNotes | null;
  sharedWithMe?: boolean;
  ownerEmail?: string | null;
  customRuleHitCount: number;
}

export interface AnalysisSummary {
  id: string;
  binaryId: string;
  filename: string;
  status: AnalysisStatus;
  summary?: string | null;
  algorithmCount: number;
  seedKeyCount: number;
  canAddressCount: number;
  checksumCount: number;
  securityByteCount: number;
  stringCount: number;
  entropy?: number | null;
  confidence?: number | null;
  createdAt: string;
  completedAt?: string | null;
  sharedWithMe?: boolean;
  ownerEmail?: string | null;
  customRuleHitCount: number;
}

export interface ChatMessage {
  id: string;
  analysisId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ShareDeliveryStatus {
  recipient: string;
  status: "delivered" | "failed" | "skipped";
  error: string | null;
  messageId: string | null;
}

export interface ShareLink {
  id: string;
  token: string;
  url: string;
  analysisId: string;
  recipients: string[];
  createdAt: string;
  lastSentAt?: string | null;
  revokedAt?: string | null;
  expiresAt?: string | null;
  expiryReminderSentAt?: string | null;
  deliveryStatus: ShareDeliveryStatus[];
  provider: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ShareLinkView {
  id: string;
  viewedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  referrer: string | null;
  geoCountry: string | null;
  geoCity: string | null;
  geoLatitude: number | null;
  geoLongitude: number | null;
}

export interface SharedAnalysis {
  token: string;
  sharedAt: string;
  analysis: Analysis;
  chat: ChatMessage[];
}

export interface SharedAnalysisPreview {
  token: string;
  sharedAt: string;
  filename: string;
  requiresVerification: boolean;
}

export interface YaraRule {
  id: string;
  name: string;
  filename: string;
  fileSize: number;
  ruleCount: number;
  createdAt: string;
}

export interface WorkbenchStats {
  totalBinaries: number;
  totalAnalyses: number;
  completedAnalyses: number;
  runningAnalyses: number;
  failedAnalyses: number;
  totalAlgorithms: number;
  totalSeedKeys: number;
  totalCanAddresses: number;
  recentAnalyses: AnalysisSummary[];
}

export interface FilePreviewHexRow {
  offset: number;
  hex: string;
  ascii: string;
}

export interface FilePreview {
  path: string;
  size: number;
  previewSize: number;
  truncated: boolean;
  isPrintable: boolean;
  text?: string | null;
  hex: FilePreviewHexRow[];
}

export interface DoctorTool {
  name: string;
  available: boolean;
  version?: string | null;
  error?: string | null;
}

export interface DoctorReport {
  generatedAt: string;
  tools: DoctorTool[];
}

export interface ToolSizeLimits {
  binwalkSkipMb: number;
  yaraSkipMb: number;
  r2SkipMb: number;
  hardTimeoutMs: number;
}
