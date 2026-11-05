// kit param matcher: /src/params/hex.ts — constrains [id=hex]
export function match(param) {
	return /^[0-9a-f]+$/i.test(param);
}
