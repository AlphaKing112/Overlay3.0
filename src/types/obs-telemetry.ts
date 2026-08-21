export interface ObsTelemetryLogEntry {
  id?: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface ObsTelemetryStats {
  online: boolean;
  streaming: boolean;
  recording: boolean;
  uptimeTimecode?: string; // "00:08:49"
  uptimeDurationMs?: number;
  outputBytes?: number;
  outputBitrateKbps?: number;
  droppedFrames?: number;
  totalFrames?: number;
  droppedFramesPercent?: number; // e.g. 0.1
  cpuUsagePercent?: number; // e.g. 2.3
  memoryUsageMb?: number;
  fps?: number; // e.g. 60.0
  renderSkippedFrames?: number;
  renderTotalFrames?: number;
  currentScene?: string;
  obsVersion?: string;
  obsWebSocketVersion?: string;
  platform?: string;
  error?: string;
  logs?: ObsTelemetryLogEntry[];
  updatedAt: number;
}

