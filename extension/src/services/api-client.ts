import { JobPayload, JobResponse, VideoQuality } from '../types';
import { StorageService } from './storage';

export interface ResolveSourceResponse {
  media_url: string;
  type: string;
  duration_seconds?: number;
  qualities: VideoQuality[];
  status: 'available' | 'requires_validation' | 'unsupported';
  error?: string;
}

export class ApiClient {
  private static async getHeaders(): Promise<HeadersInit> {
    const settings = await StorageService.getSettings();
    return {
      'Content-Type': 'application/json',
      'X-API-Key': settings.api_key || '',
    };
  }

  private static async getBaseUrl(): Promise<string> {
    const settings = await StorageService.getSettings();
    return (settings.api_base_url || 'http://localhost:8000').replace(/\/+$/, '');
  }

  static async testConnection(): Promise<{ ok: boolean; message: string; data?: any }> {
    try {
      const baseUrl = await this.getBaseUrl();
      const headers = await this.getHeaders();
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        return {
          ok: false,
          message: `API returned HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const data = await res.json();
      return {
        ok: true,
        message: 'Successfully connected to backend API',
        data,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: err.message || 'Connection failed (Check server URL & CORS)',
      };
    }
  }

  static async resolveSource(mediaUrl: string, type: string, pageUrl?: string): Promise<ResolveSourceResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/sources/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        media_url: mediaUrl,
        type,
        page_url: pageUrl,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Source resolution failed (${res.status})`);
    }

    return await res.json();
  }

  static async submitJob(payload: JobPayload): Promise<JobResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok && res.status !== 202) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Job submission failed (${res.status})`);
    }

    return await res.json();
  }

  static async getJobStatus(jobId: string): Promise<JobResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Failed to fetch job (${res.status})`);
    }

    return await res.json();
  }

  static async listJobs(limit = 20, offset = 0): Promise<JobResponse[]> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/jobs?limit=${limit}&offset=${offset}`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Failed to list jobs (${res.status})`);
    }

    return await res.json();
  }

  static async cancelJob(jobId: string): Promise<JobResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Failed to cancel job (${res.status})`);
    }

    return await res.json();
  }
}
