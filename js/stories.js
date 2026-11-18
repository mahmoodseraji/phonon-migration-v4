const slug = value => String(value || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'chapter';
export function parseStoryText(source) {
 const lines=String(source||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n'),parts=[];let part=null,chapter=null,paragraph=[];
 const flushP=()=>{const t=paragraph.join(' ').replace(/\s+/g,' ').trim();if(t&&chapter)chapter.paragraphs.push(t);paragraph=[];};
 const flushC=()=>{flushP();if(chapter){chapter.text=chapter.paragraphs.join('\n\n');if(chapter.text){if(!part){part={id:'teil-1',title:'Geschichte',chapters:[]};parts.push(part);}part.chapters.push(chapter);}}chapter=null;};
 for(const raw of lines){const line=raw.trim();if(!line){flushP();continue;}
  const pm=line.match(/^Teil\s+([\wIVXLCDM]+)\s*[–—-]\s*(.+)$/i);if(pm){flushC();part={id:slug(line),title:line.replace(/\s+/g,' '),chapters:[]};parts.push(part);continue;}
  const cm=line.match(/^Kapitel\s+(\d+)\s*[:–—-]\s*(.+)$/i);if(cm){flushC();if(!part){part={id:'teil-1',title:'Geschichte',chapters:[]};parts.push(part);}chapter={id:slug(line),number:Number(cm[1]),title:line.replace(/\s+/g,' '),paragraphs:[],text:''};continue;}
  if(!chapter){if(!part){part={id:'teil-1',title:'Geschichte',chapters:[]};parts.push(part);}chapter={id:'kapitel-1',number:1,title:'Kapitel 1',paragraphs:[],text:''};}paragraph.push(line);
 }flushC();return parts.filter(p=>p.chapters.length);
}
export async function extractDocxText(file){
 if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot unpack DOCX files. Import a .txt file instead.');
 const bytes=new Uint8Array(await file.arrayBuffer()),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),sig=o=>v.getUint32(o,true);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(sig(i)===0x06054b50){end=i;break;}
 if(end<0)throw new Error('This is not a valid DOCX archive.');
 const count=v.getUint16(end+10,true);let at=v.getUint32(end+16,true),xmlBytes=null;
 for(let i=0;i<count;i++){if(sig(at)!==0x02014b50)throw new Error('The DOCX directory is invalid.');
  const method=v.getUint16(at+10,true),size=v.getUint32(at+20,true),nl=v.getUint16(at+28,true),el=v.getUint16(at+30,true),cl=v.getUint16(at+32,true),local=v.getUint32(at+42,true),name=new TextDecoder().decode(bytes.slice(at+46,at+46+nl));
  if(name==='word/document.xml'){const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true),data=bytes.slice(start,start+size);
   if(method===0)xmlBytes=data;else if(method===8){const stream=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));xmlBytes=new Uint8Array(await new Response(stream).arrayBuffer());}else throw new Error('Unsupported DOCX compression.');break;
  }at+=46+nl+el+cl;
 }
 if(!xmlBytes)throw new Error('DOCX document.xml was not found.');
 const xml=new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes),'application/xml');if(xml.querySelector('parsererror'))throw new Error('Could not read the DOCX text.');
 return [...xml.getElementsByTagName('w:p')].map(p=>{const out=[];for(const n of p.getElementsByTagName('*')){if(n.localName==='t')out.push(n.textContent||'');else if(n.localName==='tab')out.push('\t');else if(['br','cr'].includes(n.localName))out.push('\n');}return out.join('').trim();}).filter(Boolean).join('\n\n');
}
export function splitStorySentences(p){return String(p||'').match(/[^.!?…]+(?:[.!?…]+["»”’)]*)?|[.!?…]+/gu)?.map(s=>s.trim()).filter(Boolean)||[];}
