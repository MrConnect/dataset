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
        const raw = body?.detail;
        detail = typeof raw === 'string' ? raw : typeof raw?.message === 'string' ? raw.message : JSON.stringify(raw || body);
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
      const health = await fetch(`${baseUrl}/api/v1/health`, { method: 'GET' });
      if (!health.ok) {
        return { ok: false, message: `API returned HTTP ${health.status}: ${health.statusText}` };
      }
      const data = await health.json();

      // /health is public, so a reachable server proves nothing about the key.
      const auth = await fetch(`${baseUrl}/api/v1/auth/me`, { method: 'GET', headers });
      if (auth.status === 401) {
        return { ok: false, message: 'Server reached, but the API key was rejected. Generate a client key in the dashboard (System & connection).' };
      }
      if (!auth.ok) {
        return { ok: false, message: `Key check failed with HTTP ${auth.status}` };
      }
      const who = await auth.json();
      const insecure = baseUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl);
      return {
        ok: true,
        message: `Connected as ${who.role === 'admin' ? 'administrator' : `client "${who.name}"`}` +
          (insecure ? ' — warning: this URL is plain HTTP, so the key and uploads travel unencrypted. Use HTTPS.' : ''),
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

  /**
   * Upload a job's source video in resumable chunks.
   *
   * A single multi-gigabyte POST dies on the first proxy timeout or network
   * blip. Here each chunk is its own request; after a failure the client asks
   * the server how many bytes it holds and continues from there. The server
   * verifies the finished file (playable video, long enough for every
   * segment) before the job is resumed.
   */
  static async uploadJobSource(
    jobId: string,
    file: File,
    onProgress?: (sentBytes: number, totalBytes: number, verifying: boolean) => void
  ): Promise<{ warning?: string | null; duration_seconds?: number }> {
    const baseUrl = await this.getBaseUrl();
    const jsonHeaders = await this.getHeaders();
    const settings = await StorageService.getSettings();
    const keyHeader = { 'X-API-Key': settings.api_key || '' };

    const created = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ filename: file.name, size: file.size, job_id: jobId }),
    });
    if (!created.ok) throw await this.responseError(created, 'Could not start upload');
    const session: { upload_id: string; chunk_size?: number } = await created.json();
    const uploadUrl = `${baseUrl}/api/v1/uploads/${session.upload_id}`;
    const chunkSize = session.chunk_size || 8 * 1024 * 1024;

    const receivedOnServer = async (): Promise<number | null> => {
      try {
        const res = await fetch(uploadUrl, { method: 'GET', headers: keyHeader });
        if (res.status === 404) throw new Error('Upload session expired on the server. Start the upload again.');
        if (!res.ok) return null;
        return (await res.json()).received;
      } catch (err: any) {
        if (String(err?.message || '').includes('expired')) throw err;
        return null; // still offline; the caller retries
      }
    };

    try {
      let offset = 0;
      let failures = 0;
      while (offset < file.size) {
        let res: Response | null = null;
        try {
          res = await fetch(`${uploadUrl}?offset=${offset}`, {
            method: 'PUT',
            headers: { ...keyHeader, 'Content-Type': 'application/octet-stream' },
            body: file.slice(offset, offset + chunkSize),
          });
        } catch {
          res = null; // network error
        }

        if (res?.ok) {
          offset = (await res.json()).received;
          failures = 0;
          onProgress?.(offset, file.size, false);
          continue;
        }
        if (res && [401, 403, 404, 413, 415].includes(res.status)) {
          throw await this.responseError(res, 'Source upload failed');
        }

        failures += 1;
        if (failures > 8) {
          throw res ? await this.responseError(res, 'Source upload failed') : new Error('Upload interrupted: the server is unreachable.');
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** failures, 15000)));
        const known = await receivedOnServer();
        if (known !== null) offset = known;
      }

      onProgress?.(file.size, file.size, true);
      const done = await fetch(`${uploadUrl}/complete`, { method: 'POST', headers: keyHeader });
      if (!done.ok) throw await this.responseError(done, 'The server rejected the uploaded video');
      return await done.json();
    } catch (err) {
      fetch(uploadUrl, { method: 'DELETE', headers: keyHeader }).catch(() => {});
      throw err;
    }
  }
}
