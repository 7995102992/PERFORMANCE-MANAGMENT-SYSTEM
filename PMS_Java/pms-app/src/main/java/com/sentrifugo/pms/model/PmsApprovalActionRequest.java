package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;

/** HOD approves or returns one employee's goals (screen 5.2). */
public record PmsApprovalActionRequest(
        @JsonProperty("employee_user_id") @NotBlank String employeeUserId,
        @JsonProperty("financial_year") @NotBlank String financialYear,
        @JsonProperty("remarks") String remarks) {
}
