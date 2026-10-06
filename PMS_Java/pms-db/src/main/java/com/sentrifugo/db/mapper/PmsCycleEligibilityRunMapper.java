package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleEligibilityRunDTO;
import com.sentrifugo.db.entity.PmsCycleEligibilityRunEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsCycleEligibilityRunMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCycleEligibilityRunEntity toEntity(PmsCycleEligibilityRunDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCycleEligibilityRunDTO toDTO(PmsCycleEligibilityRunEntity entity);

    List<PmsCycleEligibilityRunEntity> toEntityList(List<PmsCycleEligibilityRunDTO> dtoList);

    List<PmsCycleEligibilityRunDTO> toDTOList(List<PmsCycleEligibilityRunEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCycleEligibilityRunDTO dto, @MappingTarget PmsCycleEligibilityRunEntity entity);
}
