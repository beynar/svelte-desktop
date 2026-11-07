import { error } from '#kit';

// error() inside an endpoint must serialize to a Response — it never
// escapes through event.fetch into the calling load.
export function GET() {
	error(418, 'teapot');
}
