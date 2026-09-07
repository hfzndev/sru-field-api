'use client';

import Link from 'next/link';
import { api } from '../_lib/api';
import { useLoader } from '../_lib/useLoader';
import { completionText, formatDate } from '../_lib/format';
import { Alert, Card, Chip, Empty, Loading, PageHead, Progress, SectionHead } from '../_components/ui';
import { CaretRight, ClipboardText, ICON, Plus } from '../_components/icons';

/**
 * Lembar tugas — the supervisor's list (doc 03 §4).
 *
 * A lembar is a table the supervisor designs: columns of a chosen type, rows
 * naming the equipment to visit, and an example photo per photo-column. The
 * operator fills it from the handset, offline; the supervisor can fill cells
 * from the grid too.
 */
export default function SheetsPage() {
  const { data, error } = useLoader(() => api.get('/api/admin/sheets'));
  const sheets = data?.sheets ?? null;

  if (error && !sheets) return <Alert error={error} />;
  if (!sheets) return <Loading />;

  const open = sheets.filter((s) => s.status === 'OPEN');
  const closed = sheets.filter((s) => s.status !== 'OPEN');

  // The "Lembar" link carries `btn` as well as `btn-primary`: the button rules
  // in globals.css are keyed to the <button> element, so an anchor has to opt in.
  return (
    <>
      <PageHead
        title="Lembar Tugas"
        subtitle="Susun tabel tugas sendiri — kolom, baris, dan foto contoh. Operator mengisinya dari HP, tetap jalan tanpa sinyal."
        action={
          <Link className="btn btn-primary" href="/admin/sheets/new">
            <Plus size={ICON.inline} aria-hidden="true" /> Lembar
          </Link>
        }
      />

      {sheets.length === 0 ? (
        <Empty
          icon={ClipboardText}
          title="Belum ada lembar tugas"
          hint="Buat lembar agar operator tahu apa yang harus difoto dan dicatat."
        />
      ) : (
        <>
          <SectionHead>Berjalan ({open.length})</SectionHead>
          {open.length === 0
            ? <Card><div className="card-meta">Tidak ada lembar yang sedang berjalan.</div></Card>
            : open.map((sheet) => <SheetCard key={sheet.id} sheet={sheet} />)}

          {closed.length > 0 && (
            <>
              <SectionHead>Ditutup ({closed.length})</SectionHead>
              {closed.map((sheet) => <SheetCard key={sheet.id} sheet={sheet} />)}
            </>
          )}
        </>
      )}
    </>
  );
}

function SheetCard({ sheet }) {
  const { rowsDone, rows, total } = sheet.progress;

  return (
    <Card as={Link} href={`/admin/sheets/${sheet.id}`}>
      <div className="card-row">
        <div className="grow">
          <div className="card-title">
            {sheet.title}
            <CaretRight size={ICON.inline} aria-hidden="true" />
          </div>
          <div className="card-meta">
            {sheet.assignedShift || 'Semua shift'}
            {sheet.dueDate ? ` · target ${formatDate(sheet.dueDate)}` : ''}
          </div>
          {/* The count, not the percentage: an operator thinks in rows walked,
              and so does the supervisor chasing them. */}
          <div className="sheet-count">{completionText(rowsDone, rows, total)}</div>
        </div>
        <Chip value={sheet.status} />
      </div>

      <Progress value={rows === 0 ? 0 : Math.round((rowsDone / rows) * 100)} />
    </Card>
  );
}
