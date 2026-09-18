// Better Auth's own default mount path; the auth Worker mounts the handler
// there unless `basePath` is set, and the session client calls it there
// unless told otherwise, so the two defaults are one value.
export const DEFAULT_BASE_PATH = '/api/auth';
