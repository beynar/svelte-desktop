<script>
	// Root of a popover route. Inside the shell's popover it:
	//   - makes the page background transparent so the native vibrancy shows,
	//   - sizes the popover to its content (`fit`: 'height' default, 'both', 'none'),
	//   - removes body margins/scrollbars.
	// In a normal window or a browser it renders as a plain block.
	//
	//   <PopoverContent>
	//     <h3>Quick note</h3> …
	//     <button onclick={closePopover}>Done</button>
	//   </PopoverContent>
	import { currentPopover, popover } from '../index.ts';

	let { fit = 'height', padding = '12px', class: klass = '', children } = $props();

	const inPopover = currentPopover() !== null;
	let root = $state();

	$effect(() => {
		if (!inPopover) return;
		const html = document.documentElement;
		const prev = [html.style.background, document.body.style.background, document.body.style.margin, html.style.overflow];
		html.style.background = 'transparent';
		document.body.style.background = 'transparent';
		document.body.style.margin = '0';
		html.style.overflow = 'hidden';
		return () => {
			[html.style.background, document.body.style.background, document.body.style.margin, html.style.overflow] = prev;
		};
	});

	$effect(() => {
		if (!inPopover || fit === 'none' || !root) return;
		let last = '';
		let frame = 0;
		const report = () => {
			frame = 0;
			const r = root.getBoundingClientRect();
			const size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
			const key = fit === 'both' ? `${size.width}x${size.height}` : `${size.height}`;
			if (!size.height || key === last) return;
			last = key;
			popover.setSize(fit === 'both' ? size : { height: size.height }).catch(() => {});
		};
		const ro = new ResizeObserver(() => (frame ||= requestAnimationFrame(report)));
		ro.observe(root);
		report();
		return () => {
			ro.disconnect();
			cancelAnimationFrame(frame);
		};
	});
</script>

<div
	bind:this={root}
	class="shell-popover-content {klass}"
	style:padding
	style:width={inPopover && fit === 'both' ? 'max-content' : undefined}
	data-in-popover={inPopover || undefined}
>
	{@render children?.()}
</div>

<style>
	.shell-popover-content {
		box-sizing: border-box;
	}
</style>
