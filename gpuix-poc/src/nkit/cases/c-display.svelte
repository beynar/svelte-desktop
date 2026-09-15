<script>
	import Chip from '../Chip.svelte';
	import Card from '../Card.svelte';
	import Heading from '../Heading.svelte';
	import Kbd from '../Kbd.svelte';
	import Separator from '../Separator.svelte';
	import Badge from '../Badge.svelte';
	import Stat from '../Stat.svelte';
	import Empty from '../Empty.svelte';
	import Avatar from '../Avatar.svelte';
</script>
<div>
	<Heading level={1}>disp-title</Heading>
	<Kbd>⌘K</Kbd>
	<Badge>badge-new</Badge>
	<Separator />
	<Chip color="warning">chip-beta</Chip>
	<Card title="card-t" description="card-d">card-body</Card>
	<Stat label="stat-l" value="42" />
	<Empty title="empty-t" description="empty-d" />
	<Avatar fallback="Ada Lovelace" />
</div>
