package com.sentrifugo.db.dto;

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
public class PmsGoalTemplateKraDTO extends BaseDTO {

    private UUID id;

    private Integer displayOrder;

    private UUID templateId;

    private UUID kraId;
}
