import { Category, JobPayload, JobResponse, VideoQuality } from '../types';
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
  private static async responseError(res: Response, fallback: string): Promise<Error> {
    const requestId = res.headers.get('x-request-id');
    let detail = '';
    try {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const body = await res.json();
        detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail || body);
      } else {
        detail = (await res.text()).trim();
      }
    } catch {
      // Use the HTTP status fallback below.
    }
    const suffix = requestId ? ` [${requestId}]` : '';
    return new Error(`${detail || fallback} (HTTP ${res.status})${suffix}`);
  }

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

  static async resolveSource(
    mediaUrl: string,
    type: string,
    pageUrl?: string,
    sourceHeaders?: Record<string, string>
  ): Promise<ResolveSourceResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/sources/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        media_url: mediaUrl,
        type,
        page_url: pageUrl,
        headers: sourceHeaders,
      }),
    });

    if (!res.ok) {
      throw await this.responseError(res, 'Source resolution failed');
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

    if (!res.ok) {
      throw await this.responseError(res, 'Job submission failed');
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
      throw await this.responseError(res, 'Failed to fetch job');
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
      throw await this.responseError(res, 'Failed to list jobs');
    }

    return await res.json();
  }

  static async listCategories(): Promise<Category[]> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/categories`, { method: 'GET', headers });
    if (!res.ok) throw await this.responseError(res, 'Failed to load labels');
    return await res.json();
  }

  static async syncCategories(categories: Category[]): Promise<Category[]> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/categories/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(categories),
    });
    if (!res.ok) throw await this.responseError(res, 'Failed to sync labels');
    return await res.json();
  }

  static async syncStoredCategories(): Promise<Category[]> {
    const localCategories = await StorageService.getCategories();
    const remoteCategories = await this.listCategories();
    const initialized = await StorageService.isCategorySyncInitialized();
    let effectiveCategories = remoteCategories;

    if (!initialized) {
      const merged = new Map(remoteCategories.map((category) => [category.id, category]));
      localCategories.forEach((category) => merged.set(category.id, category));
      effectiveCategories = await this.syncCategories(Array.from(merged.values()));
    }

    await StorageService.saveCategories(effectiveCategories);
    await StorageService.markCategorySyncInitialized();
    return effectiveCategories;
  }

  static async deleteCategory(categoryId: string): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/categories/${encodeURIComponent(categoryId)}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok && res.status !== 404) throw await this.responseError(res, 'Failed to delete label');
  }

  static async cancelJob(jobId: string): Promise<JobResponse> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers,
    });

    if (!res.ok) {
      throw await this.responseError(res, 'Failed to cancel job');
    }

    return await res.json();
  }

  static async deleteJob(jobId: string): Promise<{ ok: boolean; deleted_files: number; deleted_bytes: number }> {
    const baseUrl = await this.getBaseUrl();
    const headers = await this.getHeaders();
    const res = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers,
    });

    if (!res.ok) {
      throw await this.responseError(res, 'Failed to delete job');
    }
    return await res.json();
  }

  static async uploadJobSource(jobId: string, file: File): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const settings = await StorageService.getSettings();
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/source`, {
      method: 'POST',
      headers: { 'X-API-Key': settings.api_key || '' },
      body,
    });
    if (!res.ok) {
      throw await this.responseError(res, 'Source upload failed');
    }
  }
}
