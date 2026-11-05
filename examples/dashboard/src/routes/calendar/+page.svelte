<script lang="ts">
	import { EventCalendar, type EventCalendarSlotSelectPayload } from 'entasis/event-calendar';
	import { calendar, timeZone } from '#lib/data.svelte';

	let date = $state(new Date());
	let view = $state<'month' | 'week' | 'day' | 'days' | 'agenda' | 'resource'>('week');

	// Picking an empty slot (drag, click-click or keyboard) creates an event there.
	function create({ slot }: EventCalendarSlotSelectPayload) {
		const title = 'New event';
		const id = `new-${crypto.randomUUID()}`; // shared with the other tabs: each has its own counter
		calendar.items = [
			...calendar.items,
			slot.allDay ? { id, title, start: slot.start, end: slot.end, allDay: true, color: 'primary' } : { id, title, start: slot.start, end: slot.end, color: 'primary' }
		];
	}
</script>

<svelte:head><title>Calendar</title></svelte:head>

<div class="h-full p-6">
	<EventCalendar
		bind:items={calendar.items}
		bind:date
		bind:view
		{timeZone}
		onSelect={create}
		timeGrid={{ startHour: 7, endHour: 21, scrollToHour: 8 }}
		showDatePicker
		class="h-[max(24rem,calc(100vh-12rem))] w-full"
	/>
</div>
