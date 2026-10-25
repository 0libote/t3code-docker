import { deflateRawSync, crc32 } from 'node:zlib';
// Independently assemble small ZIP fixtures, including intentionally invalid
// names/metadata that a normal zipper refuses to create.
export function zipFixture(entries,{zip64=false}={}){
 const locals=[],central=[];let offset=0;
 for(const row of entries){const name=Buffer.from(row.name),data=Buffer.from(row.data||''),packed=row.stored?data:deflateRawSync(data),length=row.declared??data.length,checksum=row.crc??crc32(data),flags=row.flags??0x800,method=row.stored?0:8;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(length,22);local.writeUInt16LE(name.length,26);locals.push(local,name,packed);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x031e,4);record.writeUInt16LE(20,6);record.writeUInt16LE(flags,8);record.writeUInt16LE(method,10);record.writeUInt32LE(checksum,16);record.writeUInt32LE(packed.length,20);record.writeUInt32LE(length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(((row.mode??0o100644)*65536)>>>0,38);record.writeUInt32LE(offset,42);central.push(record,name);offset+=local.length+name.length+packed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22),extra=[];end.writeUInt32LE(0x06054b50);end.writeUInt16LE(zip64?0xffff:entries.length,8);end.writeUInt16LE(zip64?0xffff:entries.length,10);end.writeUInt32LE(zip64?0xffffffff:directory.length,12);end.writeUInt32LE(zip64?0xffffffff:offset,16);
 if(zip64){const large=Buffer.alloc(56),locator=Buffer.alloc(20);large.writeUInt32LE(0x06064b50);large.writeBigUInt64LE(44n,4);large.writeUInt16LE(45,12);large.writeUInt16LE(45,14);large.writeBigUInt64LE(BigInt(entries.length),24);large.writeBigUInt64LE(BigInt(entries.length),32);large.writeBigUInt64LE(BigInt(directory.length),40);large.writeBigUInt64LE(BigInt(offset),48);locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(BigInt(offset+directory.length),8);locator.writeUInt32LE(1,16);extra.push(large,locator);}
 return Buffer.concat([...locals,directory,...extra,end]);
}
