/**
 * Copyright 2020-Present Han Lee <hanlee.dev@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CommonCtrlID } from '../constants/ctrlID'
import { SectionTagID } from '../constants/tagID'
import { Control } from '../models/controls'
import CommonControl from '../models/controls/common'
import ShapeControl from '../models/controls/shapes/shape'
import TableControl, { TableColumnOption } from '../models/controls/table'
import Section from '../models/section'
import Paragraph from '../models/paragraph'
import ParagraphList from '../models/paragraphList'
import HWPChar, { CharType } from '../models/char'
import ShapePointer from '../models/shapePointer'
import LineSegment from '../models/lineSegment'
import HWPRecord from '../models/record'
import ByteReader from '../utils/byteReader'
import RecordReader from '../utils/recordReader'
import { isTable, isShape } from '../utils/controlUtil'
import parseRecord from './parseRecord'
import { PictureControl } from '../models/controls/shapes'

class SectionParser {
  private record: HWPRecord

  private result: Section

  private content: Paragraph[] = []

  constructor(data: Uint8Array) {
    this.record = parseRecord(data)
    this.result = new Section()
  }

  visitPageDef(record: HWPRecord) {
    const reader = new ByteReader(record.payload)
    this.result.width = reader.readUInt32()
    this.result.height = reader.readUInt32()
    this.result.paddingLeft = reader.readUInt32()
    this.result.paddingRight = reader.readUInt32()
    this.result.paddingTop = reader.readUInt32()
    this.result.paddingBottom = reader.readUInt32()
    this.result.headerPadding = reader.readUInt32()
    this.result.footerPadding = reader.readUInt32()

    // TODO: (@hahnlee) 속성정보도 파싱하기
  }

  // TODO: (@hahnlee) mapper 패턴 사용하기
  visitParaText(record: HWPRecord, paragraph: Paragraph) {
    const reader = new ByteReader(record.payload)

    let readByte = 0

    while (readByte < record.size) {
      const charCode = reader.readUInt16()

      switch (charCode) {
        // Char
        case 0:
        case 10:
        case 13: {
          paragraph.content.push(
            new HWPChar(CharType.Char, charCode),
          )
          paragraph.textSize += 1
          readByte += 2
          break
        }

        // Inline
        case 4:
        case 5:
        case 6:
        case 7:
        case 8:
        case 9:
        case 19:
        case 20: {
          paragraph.content.push(
            new HWPChar(CharType.Inline, charCode),
          )
          paragraph.textSize += 8
          reader.skipByte(14)
          readByte += 16
          break
        }

        // Extened
        case 1:
        case 2:
        case 3:
        case 11:
        case 12:
        case 14:
        case 15:
        case 16:
        case 17:
        case 18:
        case 21:
        case 22:
        case 23: {
          paragraph.content.push(
            new HWPChar(CharType.Extened, charCode),
          )
          reader.skipByte(14)
          paragraph.textSize += 8
          readByte += 16
          break
        }

        default: {
          paragraph.content.push(
            new HWPChar(CharType.Char, String.fromCharCode(charCode)),
          )
          paragraph.textSize += 1
          readByte += 2
        }
      }
    }
  }

  visitCharShape(record: HWPRecord, paragraph: Paragraph) {
    const reader = new ByteReader(record.payload)

    const shapePointer = new ShapePointer(
      reader.readUInt32(),
      reader.readUInt32(),
    )

    paragraph.shapeBuffer.push(shapePointer)
  }

  visitCommonControl(reader: ByteReader, control: CommonControl) {
    control.attrubute = reader.readUInt32()
    control.verticalOffset = reader.readUInt32()
    control.horizontalOffset = reader.readUInt32()
    control.width = reader.readUInt32()
    control.height = reader.readUInt32()
    control.zIndex = reader.readUInt32()
    control.margin = [
      reader.readInt16(),
      reader.readInt16(),
      reader.readInt16(),
      reader.readInt16(),
    ]
    control.uid = reader.readUInt32()
    control.split = reader.readInt32()
  }

  visitTableControl(reader: ByteReader) {
    const tableControl = new TableControl()
    tableControl.id = CommonCtrlID.Table

    this.visitCommonControl(reader, tableControl)

    return tableControl
  }

  getControl(reader: ByteReader): Control {
    const ctrlID = reader.readUInt32()

    if (ctrlID === CommonCtrlID.Table) {
      return this.visitTableControl(reader)
    }

    if (ctrlID === CommonCtrlID.GenShapeObject) {
      const shape = new ShapeControl()
      shape.id = ctrlID
      this.visitCommonControl(reader, shape)
      return shape
    }

    return {
      id: ctrlID,
    }
  }

  visitControlHeader(record: HWPRecord, paragraph: Paragraph) {
    const reader = new ByteReader(record.payload)

    const control = this.getControl(reader)

    const childrenReader = new RecordReader(record.children)

    while (childrenReader.hasNext()) {
      this.visit(childrenReader, paragraph, control)
    }

    paragraph.controls.push(control)
  }

  visitCellListHeader(reader: ByteReader): TableColumnOption {
    const option: TableColumnOption = {
      column: reader.readUInt16(),
      row: reader.readUInt16(),
      colSpan: reader.readUInt16(),
      rowSpan: reader.readUInt16(),
      width: reader.readUInt32(),
      height: reader.readUInt32(),
      padding: [
        reader.readUInt16(),
        reader.readUInt16(),
        reader.readUInt16(),
        reader.readUInt16(),
      ],
      borderFillID: reader.readUInt16() - 1,
    }

    return option
  }

  visitListHeader(record: HWPRecord, reader: RecordReader, control?: Control) {
    if (!control) {
      throw new Error(`Except: control, Recived: ${control}`)
    }

    const byteReader = new ByteReader(record.payload)
    const paragraphs = byteReader.readInt32()

    // attrubute
    byteReader.readInt32()

    const items: Paragraph[] = []

    for (let i = 0; i < paragraphs; i += 1) {
      const next = reader.read()
      this.visitParagraphHeader(next, items, control)
    }

    if (record.parentTagID === SectionTagID.HWPTAG_CTRL_HEADER) {
      if (isTable(control)) {
        const options = this.visitCellListHeader(byteReader)
        const list = new ParagraphList(options, items)
        control.addRow(options.row, list)
      }
    }

    if (record.parentTagID === SectionTagID.HWPTAG_SHAPE_COMPONENT) {
      if (isShape(control)) {
        control.content.push(new ParagraphList(null, items))
      }
    }
  }

  visitTable(record: HWPRecord, control?: TableControl) {
    const reader = new ByteReader(record.payload)

    if (!control) {
      throw new Error('Expect control')
    }

    if (control.id !== CommonCtrlID.Table) {
      throw new Error(`Expect: ${CommonCtrlID.Table}, Recived: ${control.id}`)
    }

    control.tableAttribute = reader.readUInt32()
    control.rowCount = reader.readUInt16()
    control.columnCount = reader.readUInt16()

    reader.skipByte(10 + (2 * control.rowCount))

    control.borderFillID = reader.readUInt16()
  }

  visitShapeComponent(record: HWPRecord, paragraph: Paragraph, control: ShapeControl) {
    const childrenReader = new RecordReader(record.children)

    while (childrenReader.hasNext()) {
      this.visit(childrenReader, paragraph, control)
    }
  }

  visitPicture(record: HWPRecord, control: PictureControl) {
    if (!isShape(control)) {
      throw new Error('Control type not matched')
    }

    const reader = new ByteReader(record.payload)
    reader.skipByte((4 * 17) + 3)

    control.type = CommonCtrlID.Picture

    control.info = {
      binID: reader.readUInt16() - 1,
    }
  }

  visitLineSegment(record: HWPRecord, paragraph: Paragraph) {
    const reader = new ByteReader(record.payload)
    while (!reader.isEOF()) {
      const lineSegment = new LineSegment()

      lineSegment.start = reader.readUInt32()
      lineSegment.y = reader.readInt32()
      lineSegment.height = reader.readInt32()
      lineSegment.textHeight = reader.readInt32()
      lineSegment.baseLineGap = reader.readInt32()
      lineSegment.lineSpacing = reader.readInt32()
      lineSegment.startByte = reader.readInt32()
      lineSegment.width = reader.readInt32()
      reader.readUInt32()

      paragraph.lineSegments.push(lineSegment)
    }
  }

  visit(reader: RecordReader, paragraph: Paragraph, control?: Control) {
    const record = reader.read()

    switch (record.tagID) {
      case SectionTagID.HWPTAG_LIST_HEADER: {
        this.visitListHeader(record, reader, control)
        break
      }

      case SectionTagID.HWPTAG_PAGE_DEF: {
        this.visitPageDef(record)
        break
      }

      case SectionTagID.HWPTAG_PARA_TEXT: {
        this.visitParaText(record, paragraph)
        break
      }

      case SectionTagID.HWPTAG_PARA_CHAR_SHAPE: {
        this.visitCharShape(record, paragraph)
        break
      }

      case SectionTagID.HWPTAG_CTRL_HEADER: {
        this.visitControlHeader(record, paragraph)
        break
      }

      case SectionTagID.HWPTAG_TABLE: {
        this.visitTable(record, control as TableControl)
        break
      }

      case SectionTagID.HWPTAG_SHAPE_COMPONENT: {
        this.visitShapeComponent(record, paragraph, control as ShapeControl)
        break
      }

      case SectionTagID.HWPTAG_SHAPE_COMPONENT_PICTURE: {
        this.visitPicture(record, control as ShapeControl)
        break
      }

      case SectionTagID.HWPTAG_PARA_LINE_SEG: {
        this.visitLineSegment(record, paragraph)
        break
      }

      default:
        break
    }
  }

  visitParagraphHeader(record: HWPRecord, content: Paragraph[], control?: Control) {
    const result = new Paragraph()

    const reader = new ByteReader(record.payload)

    reader.skipByte(8)

    result.shapeIndex = reader.readUInt16()

    const childrenRecordReader = new RecordReader(record.children)

    while (childrenRecordReader.hasNext()) {
      this.visit(childrenRecordReader, result, control)
    }

    content.push(result)
  }

  traverse(record: HWPRecord) {
    const reader = new RecordReader(record.children)

    while (reader.hasNext()) {
      this.visitParagraphHeader(reader.read(), this.content)
    }
  }

  parse(): Section {
    this.traverse(this.record)
    this.result.content = this.content
    return this.result
  }
}

export default SectionParser
