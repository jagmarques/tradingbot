import PDFDocument from "pdfkit";
import { Trader } from "../traders/types.js";

export async function exportTradersToPdf(traders: Trader[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
    });

    const buffers: Buffer[] = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    // Title
    doc.fontSize(20).font("Helvetica-Bold").text("Profitable Traders Report", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica").fillColor("gray").text(`Generated: ${new Date().toISOString()}`, { align: "center" });
    doc.moveDown();

    // Summary
    doc.fillColor("black").fontSize(12).font("Helvetica-Bold").text("Summary");
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica");
    doc.text(`Total Traders: ${traders.length}`);

    const totalPnl = traders.reduce((sum, t) => sum + t.totalPnlUsd, 0);
    const avgWinRate = traders.length > 0 ? traders.reduce((sum, t) => sum + t.winRate, 0) / traders.length : 0;

    doc.text(`Total P&L: $${totalPnl.toFixed(2)}`);
    doc.text(`Average Win Rate: ${avgWinRate.toFixed(1)}%`);
    doc.moveDown();

    // Separator
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown();

    // Table header
    doc.fontSize(11).font("Helvetica-Bold");
    const cols = [40, 95, 295, 355, 415, 475];
    const colWidths = [55, 200, 60, 60, 60, 80];
    let y = doc.y;

    const headers = ["Chain", "Address", "Score", "Win %", "Trades", "P&L"];
    headers.forEach((header, i) => {
      doc.text(header, cols[i], y, { width: colWidths[i] });
    });

    y += 18;
    doc.moveTo(40, y).lineTo(555, y).stroke();
    y += 8;

    // Table rows
    doc.fontSize(9).font("Courier");

    for (const trader of traders) {
      if (y > 750) {
        doc.addPage();
        y = 50;
      }

      const chain = trader.chain.toUpperCase().padEnd(7);
      const address = trader.address;
      const score = trader.score.toFixed(0);
      const winRate = trader.winRate.toFixed(0) + "%";
      const trades = trader.totalTrades.toString();
      const pnl = "$" + trader.totalPnlUsd.toFixed(0);

      doc.text(chain, cols[0], y, { width: colWidths[0] });
      doc.fontSize(7).text(address, cols[1], y, { width: colWidths[1] });
      doc.fontSize(9);
      doc.text(score, cols[2], y, { width: colWidths[2] });
      doc.text(winRate, cols[3], y, { width: colWidths[3] });
      doc.text(trades, cols[4], y, { width: colWidths[4] });
      doc.text(pnl, cols[5], y, { width: colWidths[5] });

      y += 22;
    }

    // Footer
    doc.fontSize(8).font("Helvetica").fillColor("gray");
    doc.text("Trading Bot - Trader Discovery Report", 40, 800, { align: "center" });

    doc.end();
  });
}
