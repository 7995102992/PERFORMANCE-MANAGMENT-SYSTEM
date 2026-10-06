package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/** One row of the HOD approval queue (screen 5.1). */
public record PmsApprovalItemResponse(
        @JsonProperty("employee_user_id") String employeeUserId,
        @JsonProperty("employee_name") String employeeName,
        @JsonProperty("emp_code") String empCode,
        @JsonProperty("designation_name") String designationName,
        @JsonProperty("manager_user_id") String managerUserId,
        @JsonProperty("goal_status") String goalStatus) {
}
