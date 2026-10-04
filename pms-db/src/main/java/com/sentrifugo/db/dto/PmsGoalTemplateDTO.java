package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsTemplateStatus;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.LocalDate;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsGoalTemplateDTO extends BaseDTO {

    private UUID id;

    private UUID organisationId;

    private String financialYear;

    private String templateName;

    private String description;

    private UUID departmentId;

    private UUID roleId;

    private UUID plantId;

    private LocalDate effectiveFrom;

    private PmsTemplateStatus status;
}
