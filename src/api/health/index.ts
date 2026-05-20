import request from '@/http/request'

export interface HealthStatus {
  status: string
  [key: string]: unknown
}

/** Ping book-server actuator health endpoint */
export function getHealth() {
  // actuator/health is mounted at /actuator, not under /api prefix
  // Use a dedicated axios call with baseURL trimmed to server root
  return request.get<HealthStatus>('/actuator/health', {
    baseURL: (import.meta.env.VITE_API_BASE_URL as string).replace(/\/api$/, ''),
  })
}
