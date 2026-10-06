package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsMasterStatus;
import com.sentrifugo.db.enums.PmsTargetType;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsKpiMasterDTO extends BaseDTO {

    private UUID id;

    private String organisationId;

    private String name;

    private String unit;

    private PmsTargetType targetType;

    private String expectedOutcome;

    private String evidenceRequired;

    private PmsMasterStatus status;

    private UUID kraId;
}
