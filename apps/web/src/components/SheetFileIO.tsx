import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { createUniver } from '@univerjs/presets';
import type { DocRole } from '@lingshu/shared';

type UniverAPI = ReturnType<typeof createUniver>['univerAPI'];

interface Props {
  api: UniverAPI | null;
  role: DocRole;
  title: string;
}

/** 导入按 2D 矩阵一次性写入，单次覆盖的单元格上限与工作簿容量对齐。 */
const MAX_IMPORT_CELLS = 8_000;

type CellScalar = string | number | boolean | null;

/**
 * 把 xlsx 首个工作表的单元格转成 Univer 可写入的矩形矩阵。
 * 超出工作簿容量的行列直接截断，由调用方提示；空单元格保留为 null。
 */
function toMatrix(
  sheet: XLSX.WorkSheet,
  maxRows: number,
  maxColumns: number,
): { matrix: CellScalar[][]; truncated: boolean } {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const usedColumns = raw.reduce((max, line) => Math.max(max, line?.length ?? 0), 0);
  const rowCount = Math.min(raw.length, maxRows);
  const columnCount = Math.min(usedColumns, maxColumns);
  const truncated = raw.length > maxRows || usedColumns > maxColumns;

  const matrix: CellScalar[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const line = raw[r] ?? [];
    const cells: CellScalar[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      const value = line[c];
      cells.push(
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : null,
      );
    }
    matrix.push(cells);
  }

  return { matrix, truncated };
}

/**
 * 表格文件的导入导出。
 * 导入：前端解析 xlsx，清空当前工作表后按矩阵一次性写入，写入走 Univer 命令，
 *       因此和多人在线编辑一样进入协同 op 流，其他在线成员即时收敛。
 * 导出：直接读当前工作簿所有工作表的有效区域，保留多 sheet 结构，只导出值不含样式。
 */
export function SheetFileIO({ api, role, title }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const editable = role !== 'spectator';
  const ready = api !== null;

  async function handleFile(file: File): Promise<void> {
    if (!api) return;
    setBusy(true);
    setNote('');
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const first = workbook.SheetNames[0];
      const source = first ? workbook.Sheets[first] : undefined;
      if (!first || !source) throw new Error('该文件没有可导入的工作表');

      const worksheet = api.getActiveWorkbook()?.getActiveSheet();
      if (!worksheet) throw new Error('表格尚未就绪，请稍后重试');

      const { matrix, truncated } = toMatrix(
        source,
        worksheet.getMaxRows(),
        worksheet.getMaxColumns(),
      );
      if (!matrix.length || !matrix[0]?.length) throw new Error('首个工作表没有可导入的内容');

      const lastRow = worksheet.getLastRow();
      const lastColumn = worksheet.getLastColumn();
      if (lastRow >= 0 && lastColumn >= 0) {
        worksheet.getRange(0, 0, lastRow + 1, lastColumn + 1).clearContent();
      }
      // Univer 的 CellValue 不含 null，但 setValues 会按空值写回，故此处保留 null 并做一次收窄
      worksheet
        .getRange(0, 0, matrix.length, matrix[0].length)
        .setValues(matrix as unknown as (string | number | boolean)[][]);

      setNote(
        `已导入「${first}」${matrix.length} 行 × ${matrix[0].length} 列${truncated ? '（超出容量的部分已截断）' : ''}`,
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  function handleExport(): void {
    if (!api) return;
    setNote('');
    try {
      const workbook = api.getActiveWorkbook();
      if (!workbook) throw new Error('表格尚未就绪，请稍后重试');

      const output = XLSX.utils.book_new();
      for (const worksheet of workbook.getSheets()) {
        const lastRow = worksheet.getLastRow();
        const lastColumn = worksheet.getLastColumn();
        const values =
          lastRow >= 0 && lastColumn >= 0
            ? worksheet.getRange(0, 0, lastRow + 1, lastColumn + 1).getValues()
            : [];
        XLSX.utils.book_append_sheet(
          output,
          XLSX.utils.aoa_to_sheet(values),
          worksheet.getSheetName(),
        );
      }
      XLSX.writeFile(output, `${title || '表格'}.xlsx`);
      setNote(`已导出 ${workbook.getSheets().length} 个工作表（仅值，不含样式与图片）`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : '导出失败');
    }
  }

  return (
    <>
      {editable ? (
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleFile(file);
            }}
          />
          <button
            disabled={!ready || busy}
            onClick={() => {
              if (
                window.confirm(
                  '导入会清空当前工作表的全部内容并替换为文件数据，且对其他在线成员生效，继续？',
                )
              ) {
                inputRef.current?.click();
              }
            }}
          >
            {busy ? '导入中…' : '导入 xlsx'}
          </button>
        </>
      ) : null}
      <button disabled={!ready || busy} onClick={handleExport}>
        导出 xlsx
      </button>
      {note ? (
        <span className="muted" title={note}>
          {note}
        </span>
      ) : null}
    </>
  );
}
