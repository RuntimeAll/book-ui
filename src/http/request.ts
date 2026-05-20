import axios from 'axios'

const instance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL as string,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor — attach token if present
instance.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error),
)

// Response interceptor — surface errors simply
instance.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('[http]', error?.response?.status, error?.response?.data ?? error.message)
    return Promise.reject(error)
  },
)

export default instance
