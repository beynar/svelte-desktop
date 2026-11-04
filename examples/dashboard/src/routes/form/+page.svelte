<!-- Every Entasis input in one form — and the browser's own file inputs — to see what works in the
     app's web view (the file pickers are the system's open panel). The values show live. -->
<script lang="ts">
	import { TextInput } from 'entasis/text-input';
	import { TextArea } from 'entasis/text-area';
	import { PasswordInput } from 'entasis/password-input';
	import { NumberInput } from 'entasis/number-input';
	import { PhoneInput } from 'entasis/phone-input';
	import { PinInput } from 'entasis/pin-input';
	import { AddressInput } from 'entasis/address-input';
	import { Autocomplete } from 'entasis/autocomplete';
	import { Combobox } from 'entasis/combobox';
	import { Select } from 'entasis/select';
	import { TagsInput } from 'entasis/tags-input';
	import { TagGroup } from 'entasis/tag-group';
	import { KeyValueInput } from 'entasis/key-value-input';
	import { Checkbox } from 'entasis/checkbox';
	import { CheckboxesInput } from 'entasis/checkboxes-input';
	import { RadioInput } from 'entasis/radio-input';
	import { Switch } from 'entasis/switch';
	import { Slider } from 'entasis/slider';
	import { RatingInput } from 'entasis/rating-input';
	import { DateInput } from 'entasis/date-input';
	import { DateSelectorInput } from 'entasis/date-selector';
	import { CalendarPrimitive } from 'entasis/calendar';
	import { TimeInput } from 'entasis/time-input';
	import { ColorInput } from 'entasis/color-input';
	import { ColorPickerInput } from 'entasis/color-picker';
	import { FileInput } from 'entasis/file-input';
	import { SignatureInput } from 'entasis/signature-input';
	import { VoiceInput } from 'entasis/voice-input';
	import { Button } from 'entasis/button';
	import PermissionTests from '#lib/PermissionTests.svelte';

	const countries = [
		{ value: 'fr', label: 'France', description: 'Europe' },
		{ value: 'us', label: 'United States', description: 'North America' },
		{ value: 'jp', label: 'Japan', description: 'Asia' }
	];

	let values = $state({
		name: '',
		bio: '',
		password: '',
		quantity: 1,
		phone: '',
		pin: '',
		address: null as unknown,
		domain: '',
		country: null as string | null,
		plan: 'pro',
		tags: null as string[] | null,
		category: 'news',
		metadata: null as unknown,
		terms: false,
		interests: [] as string[],
		billing: 'monthly',
		notifications: true,
		volume: 40,
		rating: 3,
		start: null as Date | null,
		due: null as Date | null,
		day: null as Date | null,
		time: null as number | null,
		brand: '#5f62ef',
		accent: '#22c55e',
		avatar: null as File | null,
		documents: null as File[] | null,
		signature: null as string | null,
		voice: null as Blob | null
	});

	// The browser's own file inputs.
	let native = $state<Record<string, File[]>>({});
	const pick = (name: string) => (e: Event) => (native[name] = [...((e.currentTarget as HTMLInputElement).files ?? [])]);

	// Files and blobs, readable.
	const show = (v: unknown): unknown =>
		v instanceof File ? `${v.name} (${v.type || 'no type'}, ${Math.round(v.size / 1024)} KB)`
		: v instanceof Blob ? `Blob (${v.type}, ${Math.round(v.size / 1024)} KB)`
		: v instanceof Date ? v.toISOString()
		: typeof v === 'string' && v.startsWith('data:') ? `${v.slice(0, 32)}… (${v.length} chars)`
		: Array.isArray(v) ? v.map(show)
		: v;
	const live = $derived(JSON.stringify(Object.fromEntries(Object.entries({ ...values, native }).map(([k, v]) => [k, k === 'native' ? Object.fromEntries(Object.entries(v as Record<string, File[]>).map(([n, f]) => [n, f.map(show)])) : show(v)])), null, 2));

	let submitted = $state<string | null>(null);
	const submit = (e: SubmitEvent) => {
		e.preventDefault();
		submitted = new Date().toLocaleTimeString();
	};
</script>

<svelte:head><title>Form</title></svelte:head>

<form class="grid gap-8 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]" onsubmit={submit}>
	<div class="flex min-w-0 flex-col gap-8">
		<section class="flex flex-col gap-3">
			<div>
				<h2 class="text-neutral text-base font-semibold">Permissions</h2>
				<p class="text-neutral-readable text-sm">The web APIs that ask the system: the prompt comes the first time (the voice note below is the microphone).</p>
			</div>
			<PermissionTests />
		</section>

		<section class="flex flex-col gap-4">
			<h2 class="text-neutral text-base font-semibold">Files</h2>
			<FileInput label="Avatar" description="One image, dropped or picked (the system's open panel)" bind:value={values.avatar} />
			<FileInput label="Documents" description="Several files, PDF or Word, 10 MB each" mode="multiple" maxFiles={5} maxSize={10 * 1024 * 1024} types={['.pdf', '.doc', '.docx', '.txt', '.md']} bind:value={values.documents} />
			<div class="border-neutral-muted flex flex-col gap-3 rounded-lg border p-4">
				<p class="text-neutral text-sm font-medium">The browser's own file inputs</p>
				<label class="text-neutral-readable flex flex-col gap-1 text-sm">One file <input type="file" onchange={pick('single')} /></label>
				<label class="text-neutral-readable flex flex-col gap-1 text-sm">Several files <input type="file" multiple onchange={pick('multiple')} /></label>
				<label class="text-neutral-readable flex flex-col gap-1 text-sm">Images only <input type="file" accept="image/*" multiple onchange={pick('images')} /></label>
				<label class="text-neutral-readable flex flex-col gap-1 text-sm">A folder <input type="file" webkitdirectory onchange={pick('folder')} /></label>
			</div>
		</section>

		<section class="grid gap-4 md:grid-cols-2">
			<h2 class="text-neutral text-base font-semibold md:col-span-2">Text</h2>
			<TextInput label="Name" placeholder="Ada Lovelace" required bind:value={values.name} />
			<PasswordInput label="Password" bind:value={values.password} />
			<PhoneInput label="Phone" bind:value={values.phone} />
			<NumberInput label="Quantity" min={1} max={99} bind:value={values.quantity} />
			<PinInput label="Verification code" bind:value={values.pin} />
			<Autocomplete label="Email domain" items={['gmail.com', 'outlook.com', 'proton.me']} bind:value={values.domain} />
			<div class="md:col-span-2"><TextArea label="Bio" placeholder="A few words" bind:value={values.bio} /></div>
			<div class="md:col-span-2"><AddressInput label="Delivery address" defaultCountry="FR" bind:value={values.address as never} /></div>
		</section>

		<section class="grid gap-4 md:grid-cols-2">
			<h2 class="text-neutral text-base font-semibold md:col-span-2">Choices</h2>
			<Combobox label="Country" placeholder="Search countries…" items={countries} bind:value={values.country} />
			<Select label="Plan" items={[{ value: 'free', label: 'Free' }, { value: 'pro', label: 'Pro' }, { value: 'team', label: 'Team' }]} bind:value={values.plan} />
			<TagsInput label="Tags" placeholder="Add a tag…" bind:value={values.tags} />
			<TagGroup label="Category" items={[{ value: 'news', label: 'News' }, { value: 'travel', label: 'Travel' }, { value: 'gaming', label: 'Gaming' }]} bind:value={values.category} />
			<CheckboxesInput label="Interests" items={[{ value: 'coding', label: 'Coding' }, { value: 'design', label: 'Design' }, { value: 'marketing', label: 'Marketing' }]} bind:value={values.interests} />
			<RadioInput label="Billing" items={[{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }]} bind:value={values.billing} />
			<Switch label="Notifications" bind:value={values.notifications} />
			<Checkbox label="I accept the terms" bind:value={values.terms} />
			<Slider label="Volume" min={0} max={100} step={5} showValue bind:value={values.volume} />
			<RatingInput label="Rating" bind:value={values.rating} />
			<div class="md:col-span-2"><KeyValueInput label="Metadata" bind:value={values.metadata as never} /></div>
		</section>

		<section class="grid gap-4 md:grid-cols-2">
			<h2 class="text-neutral text-base font-semibold md:col-span-2">Dates and colors</h2>
			<DateInput label="Start date" bind:value={values.start} />
			<DateSelectorInput label="Due date" bind:value={values.due} />
			<TimeInput label="Start time" format="HH:MM" bind:value={values.time} />
			<ColorInput label="Brand color" bind:value={values.brand} />
			<ColorPickerInput label="Accent" bind:value={values.accent} />
			<div><p class="text-neutral mb-2 text-sm font-medium">Day</p><CalendarPrimitive type="calendar" bind:value={values.day} /></div>
		</section>

		<section class="grid gap-4 md:grid-cols-2">
			<h2 class="text-neutral text-base font-semibold md:col-span-2">Drawing and voice</h2>
			<SignatureInput label="Signature" bind:value={values.signature} />
			<VoiceInput label="Voice note" maxDuration={60} bind:value={values.voice} />
		</section>

		<div class="flex items-center gap-3">
			<Button type="submit">Submit</Button>
			{#if submitted}<span class="text-neutral-readable text-sm">Submitted at {submitted}</span>{/if}
		</div>
	</div>

	<aside class="xl:sticky xl:top-0 xl:self-start">
		<p class="text-neutral mb-2 text-sm font-medium">Values</p>
		<pre class="bg-surface-raised border-neutral-muted text-neutral-readable max-h-[70vh] overflow-auto rounded-lg border p-3 text-xs">{live}</pre>
	</aside>
</form>
