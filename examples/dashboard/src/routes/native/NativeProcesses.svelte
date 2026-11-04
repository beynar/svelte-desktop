<script lang="ts">
  import { Button } from 'entasis/button';
  let counter = $state<{ count: number; pid: number } | null>(null);
  let bundle = $state<string | null>(null);
  let status = $state('');
  let busy = $state(false);
  async function run(action: () => Promise<void>) {
    busy = true;
    try { await action(); status = ''; } catch (error) { status = (error as Error).message; }
    finally { busy = false; }
  }
  async function post(path: string) {
    const response = await fetch(path, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
</script>

<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-service-card>
  <h2 class="text-neutral text-base font-semibold">Persistent service</h2>
  <p class="text-neutral-readable text-sm">A counter in a supervised Bun child. Each click calls a server endpoint; the process and its state stay alive across requests.</p>
  <Button variant="outline" disabled={busy} onclick={() => run(async () => { counter = await post('/native/service'); })}>Increment in the service</Button>
  {#if counter}<output data-service-result class="text-neutral-readable text-sm">Count {counter.count} · process {counter.pid}</output>{/if}
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-support-card>
  <h2 class="text-neutral text-base font-semibold">Collect a support bundle</h2>
  <p class="text-neutral-readable text-sm">Create a local archive of app logs, crash information and version metadata. Common secrets are masked. Nothing is uploaded; review it before sharing.</p>
  <Button variant="outline" disabled={busy} onclick={() => run(async () => { bundle = (await post('/native/support')).path; })}>Collect a support bundle</Button>
  {#if bundle}
    <output data-support-result class="text-neutral-readable break-all text-xs">{bundle}</output>
    <Button variant="outline" onclick={() => run(async () => { await host.shell.showItemInFolder(bundle!); })}>Reveal the archive</Button>
  {/if}
  {#if status}<p role="alert" class="text-sm">{status}</p>{/if}
</section>
