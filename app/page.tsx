export default function FleetPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Fleet</h1>
        <p className="mt-1 text-sm text-muted">
          Live state of every robot on site.
        </p>
      </div>

      <section className="rounded-xl border border-dashed border-line bg-surface/40 px-6 py-14 text-center">
        <p className="text-sm font-medium">No telemetry yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Robot state appears here once telemetry ingestion is connected.
        </p>
      </section>
    </div>
  );
}
