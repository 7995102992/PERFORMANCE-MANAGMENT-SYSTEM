package com.sentrifugo.db.dto;

import com.sentrifugo.db.enums.PmsTargetType;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.math.BigDecimal;
import java.util.UUID;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode(callSuper = true)
public class PmsGoalTemplateKpiDTO extends BaseDTO {

    private UUID id;

    private BigDecimal weightage;

    private PmsTargetType targetType;

    private Integer displayOrder;

    private UUID templateId;

    private UUID kraId;

    private UUID kpiId;
}
