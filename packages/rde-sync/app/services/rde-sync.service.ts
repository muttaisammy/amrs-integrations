import { AMRS_POOL, ETL_POOL } from "../db";
import { ResponseToolkit } from "@hapi/hapi";
import { RowDataPacket } from "mysql2";
import { QueuePatientPayload, RDEQueuePayload } from "../models/RequestParams";
import { QueueStatus } from "../models/Model";

class RdeSyncService {
  async getPatientIds(identifiers: string[]) {
    let whereQuery = "";
    identifiers.forEach((identifier) => {
      whereQuery += `'${identifier}',`;
    });

    const query = `SELECT DISTINCT patient_id FROM patient_identifier WHERE identifier IN (${whereQuery.slice(
      0,
      -1
    )})`;

    const connection = await AMRS_POOL.getConnection();
    const result = await connection.execute(query);
    connection.release();

    return result;
  }

  async queueRDEPatients(request: RDEQueuePayload, h: ResponseToolkit) {
    const { identifiers, userId, reportingMonth } = request;

    const [rows] = await this.getPatientIds(identifiers);

    const handleRow = async (row: RowDataPacket) => {
      const patientId = row.patient_id;

      const moment = require("moment-timezone");
      let now = moment().tz("Africa/Nairobi");
      let formattedDateTime = now.format("YYYY-MM-DD HH:mm:ss");

      let query = `INSERT INTO rde_sync_queue (user_id, patient_id, date_created, reporting_month, status) VALUES (${userId}, ${patientId}, '${formattedDateTime}', '${reportingMonth}', 'QUEUED')`;

      const connection = await ETL_POOL.getConnection();
      const [rows] = await connection.execute(query);
      connection.release();
      h.response(rows).created;
    };

    if (Array.isArray(rows)) {
      rows.forEach((row: any) => {
        return handleRow(row as RowDataPacket);
      });
    }
  }

  async updatePatientStatus(
    patientIds: number[],
    status: QueueStatus) {
    const connection = await ETL_POOL.getConnection();
    const queueStatus: string = QueueStatus[status];
    try {
      for (const id of patientIds) {
        const query =
          "UPDATE rde_sync_queue SET status = ? WHERE patient_id = ?";
        const [updates] = await connection.execute(query, [queueStatus, id]);
        console.info("Patient queue status updated", updates);
      }
    } catch (error) {
      console.error(error);
    } finally {
      connection.release();
    }
  }

  async deletePatientRecord(id: string, h: ResponseToolkit) {
    const identifiers = [id];
    const [patientId] = await this.getPatientIds(identifiers);
    if (Array.isArray(patientId)) {
      const id = patientId[0] as { patient_id: number };
      const query = `DELETE FROM rde_sync_queue WHERE patient_id = ${id.patient_id}`;
      const connection = await ETL_POOL.getConnection();
      const [deleted] = await connection.execute(query);
      connection.release();
      return h.response(deleted).code(204);
    }
  }

  async processingStatus(id: string, h: ResponseToolkit) {
    let count;
    try {
      const query = `SELECT * FROM hiv_monthly_report_dataset_build_queue_${id}`;
      const connection = await ETL_POOL.getConnection();
      const [rows] = await connection.execute(query);
      if (Array.isArray(rows)) {
        count = rows.length;
        connection.release();
        const response = { totalRows: count };
        return response;
      }
    } catch (err) {
      count = 0;
      const response = { totalRows: count };
      return response;
    }
  }

  async freezingData(request: QueuePatientPayload, h: ResponseToolkit) {
    const { patientIds, userId, reportingMonth } = request;

    let whereQuery = "";
    patientIds.forEach((id) => {
      whereQuery += `${id},`;
    });

    const query = `REPLACE INTO etl.hiv_monthly_report_dataset_frozen (SELECT * from etl.hiv_monthly_report_dataset_v1_2
          WHERE hiv_monthly_report_dataset_v1_2.endDate = '${reportingMonth}' AND hiv_monthly_report_dataset_v1_2.person_id
          IN (${whereQuery.slice(0, -1)}));`;

    try {
      const connection = await ETL_POOL.getConnection();
      const [rows] = await connection.execute(query);
      connection.release();
      return h.response(rows).code(201);
    } catch (e) {
      console.error(e);
      return h.response("Internal server error \n " + e).code(500);
    }
  }
}

export default RdeSyncService;
