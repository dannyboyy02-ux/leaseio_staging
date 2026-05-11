// One-shot generator for a synthetic minimal lease PDF used by the
// Tier 1/Tier 2 AI smoke test. NOT a fixture for routine use — gitignored
// output goes to /tmp/test-lease.pdf, intentionally outside the repo.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const page1 = doc.addPage([612, 792]);
const drawText = (page, text, x, y, opts = {}) => {
  page.drawText(text, {
    x, y,
    size: opts.size ?? 11,
    font: opts.bold ? bold : font,
    color: opts.color ?? rgb(0, 0, 0),
    maxWidth: opts.maxWidth,
  });
};

drawText(page1, 'COMMERCIAL OFFICE LEASE AGREEMENT', 80, 750, { size: 16, bold: true });
drawText(page1, 'PARTIES', 80, 710, { size: 13, bold: true });
drawText(page1, 'This Lease Agreement ("Lease") is entered into as of January 15, 2026', 80, 690);
drawText(page1, 'between Acme Real Estate Holdings LLC ("Landlord"), with an address of', 80, 674);
drawText(page1, '500 Madison Avenue, New York, NY 10022, and Northwind Software Inc.', 80, 658);
drawText(page1, '("Tenant"), with an address of 200 Pine Street, San Francisco, CA 94111.', 80, 642);

drawText(page1, 'PREMISES', 80, 605, { size: 13, bold: true });
drawText(page1, 'Landlord leases to Tenant the premises located at 1200 Market Street,', 80, 585);
drawText(page1, 'Suite 800, San Francisco, CA 94102 (the "Premises"), consisting of', 80, 569);
drawText(page1, 'approximately 12,500 rentable square feet.', 80, 553);

drawText(page1, 'TERM', 80, 516, { size: 13, bold: true });
drawText(page1, 'The initial term of this Lease shall commence on March 1, 2026 (the', 80, 496);
drawText(page1, '"Commencement Date") and shall expire on February 28, 2031 (the', 80, 480);
drawText(page1, '"Expiration Date"), unless sooner terminated as provided herein.', 80, 464);

drawText(page1, 'BASE RENT', 80, 427, { size: 13, bold: true });
drawText(page1, 'Tenant shall pay Base Rent of $52,083.33 per month, payable in advance', 80, 407);
drawText(page1, 'on the first day of each month. Base Rent shall escalate by three percent', 80, 391);
drawText(page1, '(3%) annually on each anniversary of the Commencement Date.', 80, 375);

drawText(page1, 'SECURITY DEPOSIT', 80, 338, { size: 13, bold: true });
drawText(page1, 'Tenant shall deposit with Landlord the sum of $156,250.00 as security', 80, 318);
drawText(page1, 'for the faithful performance of the terms of this Lease.', 80, 302);

drawText(page1, 'RENEWAL OPTION', 80, 265, { size: 13, bold: true });
drawText(page1, 'Tenant has one (1) option to renew the Lease for an additional five (5)', 80, 245);
drawText(page1, 'year term at fair market rent, exercisable by written notice delivered to', 80, 229);
drawText(page1, 'Landlord no less than twelve (12) months prior to the Expiration Date.', 80, 213);

drawText(page1, '— Page 1 of 2 —', 270, 60, { size: 9 });

const page2 = doc.addPage([612, 792]);
drawText(page2, 'TERMINATION', 80, 750, { size: 13, bold: true });
drawText(page2, 'Landlord may terminate this Lease upon ninety (90) days written notice', 80, 730);
drawText(page2, 'in the event of (a) Tenant default in the payment of rent that remains', 80, 714);
drawText(page2, 'uncured for thirty (30) days after written notice, (b) Tenant insolvency', 80, 698);
drawText(page2, 'or bankruptcy, or (c) condemnation of the Premises.', 80, 682);

drawText(page2, 'ASSIGNMENT AND SUBLETTING', 80, 645, { size: 13, bold: true });
drawText(page2, 'Tenant shall not assign this Lease or sublet any portion of the Premises', 80, 625);
drawText(page2, 'without the prior written consent of Landlord, which consent shall not be', 80, 609);
drawText(page2, 'unreasonably withheld.', 80, 593);

drawText(page2, 'INSURANCE', 80, 556, { size: 13, bold: true });
drawText(page2, 'Tenant shall maintain commercial general liability insurance with limits', 80, 536);
drawText(page2, 'of not less than $2,000,000 per occurrence and $5,000,000 in the', 80, 520);
drawText(page2, 'aggregate, naming Landlord as additional insured.', 80, 504);

drawText(page2, 'PERSONAL GUARANTY', 80, 467, { size: 13, bold: true });
drawText(page2, 'The performance of Tenant\'s obligations hereunder is personally', 80, 447);
drawText(page2, 'guaranteed by Jane Doe, Chief Executive Officer of Tenant.', 80, 431);

drawText(page2, 'EXECUTION', 80, 394, { size: 13, bold: true });
drawText(page2, 'IN WITNESS WHEREOF, the parties have executed this Lease as of the', 80, 374);
drawText(page2, 'date first written above.', 80, 358);

drawText(page2, 'LANDLORD: Acme Real Estate Holdings LLC', 80, 310);
drawText(page2, 'By: ______________________________', 80, 290);
drawText(page2, 'Name: John Smith', 80, 274);
drawText(page2, 'Title: Managing Member', 80, 258);

drawText(page2, 'TENANT: Northwind Software Inc.', 320, 310);
drawText(page2, 'By: ______________________________', 320, 290);
drawText(page2, 'Name: Jane Doe', 320, 274);
drawText(page2, 'Title: Chief Executive Officer', 320, 258);

drawText(page2, '— Page 2 of 2 —', 270, 60, { size: 9 });

const bytes = await doc.save();
const out = process.argv[2] || '/tmp/test-lease.pdf';
await writeFile(out, bytes);
console.log(`Wrote ${bytes.length} bytes to ${out}`);
