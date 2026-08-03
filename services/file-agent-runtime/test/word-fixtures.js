import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const checksum = crc32(data);
    const header = Buffer.concat([
      Buffer.from('504b0304', 'hex'),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
    ]);
    localParts.push(header, data);
    const central = Buffer.concat([
      Buffer.from('504b0102', 'hex'),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(nameBuffer.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuffer,
    ]);
    centralParts.push(central);
    offset += header.length + data.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    Buffer.from('504b0506', 'hex'),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

function xml(value) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
}

function textParagraph(value) {
  return `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
}

function splitTextParagraph() {
  return '<w:p><w:r><w:t>Source </w:t></w:r><w:r><w:t>paragraph</w:t></w:r></w:p>';
}

function tableXml(label = 'A') {
  return '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>'
    + `<w:tr><w:tc><w:p><w:r><w:t>Cell ${label}1</w:t></w:r></w:p></w:tc>`
    + `<w:tc><w:p><w:r><w:t>Cell ${label}2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
}

function documentXml({
  rich = false,
  text = 'Source paragraph',
  table = false,
  comments = false,
  splitText = false,
  repeatText = false,
} = {}) {
  const references = rich
    ? '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    : '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
  const image = rich
    ? '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    : '';
  const comment = comments
    ? '<w:p><w:commentRangeStart w:id="5"/><w:r><w:t>commented</w:t></w:r><w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r></w:p>'
    : '';
  const tables = table ? `${tableXml('A')}${rich ? tableXml('B') : ''}` : '';
  const paragraph = splitText ? splitTextParagraph() : textParagraph(text);
  const repeatedParagraph = repeatText ? textParagraph(text) : '';
  return xml(`<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraph}${repeatedParagraph}${tables}${image}${comment}${references}</w:body></w:document>`);
}

function contentTypes({ rich = false, comments = false } = {}) {
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
  ];
  if (rich) {
    overrides.push(
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
    );
  }
  if (comments) {
    overrides.push('<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>');
  }
  return xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides.join('')}</Types>`);
}

function documentRelationships({ rich = false, comments = false, brokenRelationship = false } = {}) {
  const entries = [];
  if (rich) {
    entries.push('<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>');
    entries.push('<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>');
    entries.push(`<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${brokenRelationship ? 'missing' : 'image1'}.png"/>`);
  }
  if (comments) {
    entries.push('<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>');
  }
  return xml(`<Relationships xmlns="${REL_NS}">${entries.join('')}</Relationships>`);
}

function baseEntries(options = {}) {
  const entries = [
    ['[Content_Types].xml', contentTypes(options)],
    ['_rels/.rels', xml(`<Relationships xmlns="${REL_NS}"><Relationship Id="rIdOfficeDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)],
    ['word/document.xml', documentXml(options)],
    ['word/_rels/document.xml.rels', documentRelationships(options)],
    ['word/styles.xml', xml(`<w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`)],
    ['word/settings.xml', xml(`<w:settings xmlns:w="${W_NS}"/>`)],
  ];
  if (options.rich) {
    entries.push(
      ['word/header1.xml', xml(`<w:hdr xmlns:w="${W_NS}">${textParagraph('Header')}</w:hdr>`)],
      ['word/footer1.xml', xml(`<w:ftr xmlns:w="${W_NS}">${textParagraph('Footer')}</w:ftr>`)],
      ['word/media/image1.png', ONE_PIXEL_PNG],
    );
  }
  if (options.comments) {
    entries.push(['word/comments.xml', xml(`<w:comments xmlns:w="${W_NS}"><w:comment w:id="5" w:author="fixture"><w:p><w:r><w:t>Comment</w:t></w:r></w:p></w:comment></w:comments>`)],
    );
  }
  if (options.orphanComments) {
    entries.push(['word/comments.xml', xml(`<w:comments xmlns:w="${W_NS}"><w:comment w:id="99" w:author="fixture"><w:p><w:r><w:t>Orphan</w:t></w:r></w:p></w:comment></w:comments>`)],
    );
  }
  return entries;
}

export async function writeWordFixture(filePath, kind = 'normal') {
  const options = {
    rich: kind === 'rich' || kind === 'broken-relationship',
    brokenRelationship: kind === 'broken-relationship',
    table: kind === 'table' || kind === 'rich' || kind === 'accident-replay',
    comments: kind === 'comments' || kind === 'orphan-comments' || kind === 'accident-replay',
    orphanComments: kind === 'orphan-comments' || kind === 'accident-replay',
    splitText: kind === 'split-text',
    repeatText: kind === 'repeated-text',
    text: kind === 'accident-replay' ? 'Repeated repair target' : 'Source paragraph',
  };
  await writeFile(filePath, createStoredZip(baseEntries(options)));
}
